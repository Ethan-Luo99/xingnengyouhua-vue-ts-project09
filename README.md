# “几百个函数执行”性能优化对照实验（Vue 3.5 + TS + Vite）

演示级仓库：三个高频函数执行场景的可运行基线 + 9 项优化手段（每项独立开关）+ 零依赖可观测性面板。
设计方案见 `docs/performance-plan.md`，实现边界与修正见 `docs/implementation-notes.md`。

## 运行

```bash
npm install
npm run dev        # 开发
npm run build      # vue-tsc 零错误 + vite 构建（验收硬指标之一）
npm run preview -- --port 5199   # 生产预览（性能结论以此为准）
```

## 优化开关（9 项，全部独立启停）

面板勾选或 URL 参数，两者自动同步，例如：

```
http://localhost:5199/?flags=scope,chunk,computed,flush,memo,vmemo,shallow,batch,pause
# 或全开: ?flags=all   全关(基线): 不带参数
```

| 开关 | 手段 | 场景 |
|---|---|---|
| `scope` | effectScope + onScopeDispose 统一注册/销毁 | A |
| `chunk` | rAF+MessageChannel 自适应分片调度器（8ms 预算/动态粒度/yield 降级链/取消/错误传播/重入保护） | A |
| `computed` | computed 合并重复派生（同 flush 多次读取只算一次） | B |
| `flush` | watch flush 时机分流（禁 sync，DOM 测量统一 post） | B |
| `memo` | LRU 记忆化（WeakMap 对象键，版本失效+容量淘汰） | B |
| `vmemo` | v-memo 行缓存（依赖数组 `[row.ver]`） | 表格页 |
| `shallow` | shallowRef + triggerRef 批量写 | C |
| `batch` | 流聚批 + 背压（帧率封顶，丢弃策略可配） | C |
| `pause` | watcher pause()/resume()（离屏/隐藏暂停） | C |

基线（未优化）实现全部保留，开关全关即基线。

## 验收表（硬指标）

所有指标来自页面内嵌面板真实采集（PerformanceObserver / mark-measure / 计数器），禁止硬编码。
每个场景页内有点击即用的“复跑对比”（面板下方表格同口径展示基线/优化两列）。

| # | 指标 | 阈值 | 验证步骤 |
|---|---|---|---|
| 1 | 场景A 首屏 Long Task | 基线 ≥1 个 >50ms；优化后 = 0 | 切到“场景A”，面板点“复跑对比”。读 A 表“首屏长任务数(>50ms)”行：基线列 ≥1，优化列 =0。同时“卸载后残留副作用”基线 >0、优化 =0，“卸载后定时器仍跳动”基线=是、优化=否（effectScope 零残留的行为断言） |
| 2 | 场景B 交互 INP P95 | ≤ 200ms | 切到“场景B”，开全部优化（或 `?flags=all`），手动点击“触发扇出”5 次以上，读面板“INP P95(B场景)”。渲染受影响面：面板 B 表“渲染组件数”优化列 ≈15（实际变化单元数），基线列 =60（全部单元） |
| 3 | 场景C 稳态帧成本 | 帧 JS P95 ≤ 8ms；丢帧率 < 5% | 切到“场景C”，面板点“复跑对比”（各跑 8s 稳态）。读 C 表“帧JS P95(ms)”与“丢帧率%”：优化列 ≤8ms 且 <5%，基线列显著超标 |
| 4 | 场景C 内存 | 60s 连续运行 GC 后非单调增长 | 场景C 点“60s 内存验证”（Chrome，需 `performance.memory`）。输出前段/末段堆谷底与增长率，<10% 判通过 |
| 5 | 回归：功能零变化 | 全部行为断言通过 | 场景C 点“运行 C1 边界用例”：3 个用例全 ✓（漏 trigger 可检测/帧边界不丢消息/聚批计数不变量）；表格页“复跑对比”两种模式 “stale行数” 均为 0；场景A 两种模式“任务执行数”均为 320 |
| 6 | 回归：构建 | `npm run build` 通过 | vue-tsc 零错误 + vite 构建成功 |
| 7 | 回归：包体积 | 相对基线零增加 | 优化与基线代码同包、开关为运行时切换，启停优化对包体积影响恒为 0；`package.json` dependencies 相对模板零新增（仅 vue）。当前产物 `dist/assets/index-*.js` ≈ 100.5 kB（gzip ≈ 39 kB） |

## 自动化复跑（可证伪）

```bash
npm run build && npx vite preview --port 5199 &
CHROME=/path/to/chrome node scripts/smoke.mjs
```

零 npm 依赖（Node 内置模块 + 本机 Chrome 经 CDP 驱动），对 24 条断言逐项输出 ✓/✗，
覆盖：A 长任务/残留/泄漏、B watcher 去重/派生合并/渲染面/记忆化命中/强制布局、
C 边界用例/丢帧率/渲染收敛/帧预算、C3 暂停-恢复一致性、调度器取消/错误传播/重入、
LRU 对象键/淘汰/版本失效、T 渲染收敛/stale=0。

## 面板说明（页面底部，非 DevTools）

- **实时指标**：longtask 计数/最大值、INP P95（event timing，按场景作用域）、LoAF 计数、帧间隔均值、帧 JS P95（rAF 差值法）、丢帧率、JS 堆。
- **计数器**：渲染次数、watcher 触发、computed 求值、triggerRef 次数等，可一键清零。
- **对比表**：每个手段开/关两种状态下的同口径指标，同页一键复跑。
- **采集能力行**：显示当前浏览器对 longtask / event timing / LoAF / performance.memory / scheduler.yield 的支持情况与让出原语降级结果。

## 关键文件

- `src/perf/scheduler.ts` — 分片调度器（手段 7）
- `src/perf/lruMemo.ts` — LRU 记忆化（手段 8）
- `src/perf/streamBatcher.ts` — 流聚批+背压（手段 9）
- `src/perf/metrics.ts` — 零依赖指标采集
- `src/perf/flags.ts` — 9 项开关（URL 同步）
- `src/scenarios/` — 三场景 + v-memo 表格（基线与优化同文件，开关切换）
- `scripts/smoke.mjs` — 自动化验收复跑
