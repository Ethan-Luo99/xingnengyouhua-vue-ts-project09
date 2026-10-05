# Vue 3.5 性能手段演示台（可证伪基准）

演示级仓库：Vue 3.5 + TS + Vite，**零新增 npm 依赖**。把 `docs/performance-plan.md` 标注"实现"的手段落成可运行代码，三场景均保留未优化基线实现，通过 9 个独立开关（URL 参数或面板）逐项启停，页面内嵌零依赖可观测性面板，所有指标来自真实采集。

## 运行

```bash
npm install
npm run build      # vue-tsc 零错误 + vite build
npm run preview    # 生产构建预览（性能结论以此为准）
npm run dev        # 开发模式
```

URL 参数：`?tab=a|b|c` 选场景；`?scope=0&sched=0...` 单独开关；`?baseline=1` 一键全关；`?rerun=a|b|c` 自动复跑对比；`?selftest=1` 自动跑边界自测。

## 九手段 ↔ 开关 ↔ 场景

| # | 手段 | 开关 | 场景 | 基线（off）→ 优化（on） |
|---|------|------|------|------------------------|
| 1 | effectScope + onScopeDispose | `scope` | A | 模块级 detached scope 永不停止 → 组件 scope 卸载即 stop |
| 2 | watcher pause()/resume() | `pause` | B/C | 隐藏分支 watcher 常开 → 离屏 pause、恢复 resume |
| 3 | shallowRef + triggerRef 批量写 | `shallow` | C | reactive 深数组逐条 push → 浅引用批量触发 |
| 4 | computed 合并重复派生 | `computed` | B | 每函数命令式重算 O(n) → computed 每 flush 算一次 |
| 5 | watch flush 时机分流 | `flush` | B | sync 连锁 + 同步布局读 → pre 批量 + post 测 DOM |
| 6 | v-memo 300×8 表格 | `memo` | B | 不稳定 tick prop 全表重渲染 → 依赖数组精确跳过 |
| 7 | rAF+MessageChannel 自适应分片调度器 | `sched` | A | 360 任务同步长任务 → 8ms 帧预算分片 |
| 8 | LRU 记忆化（对象入参键） | `lru` | B | 每次全量计算 → 身份字典树键缓存 |
| 9 | 流聚批 + 背压 | `batch` | C | 每条消息一轮 flush → 缓冲+rAF 合帧+丢弃策略 |

## 验收表（硬指标 + 验证步骤）

> 所有数字来自面板真实采集；以下为本次提交在 headless Chromium（Linux，无节流）下 `?rerun=*` 的实测值，复现步骤附后。不同机器数值会变，判定看相对关系与阈值。

### 验收 1 — 场景 A：首屏无 >50ms Long Task

| 指标 | 基线 | 优化 | 判定 |
|------|------|------|------|
| >50ms Long Task 数 | **1**（108ms） | **0** | ✅ |
| 任务执行段耗时 | 103.7ms | 212.2ms（分片代价，见 notes） | 说明见 notes |
| 注册任务完成数 | 360 | 360 | 功能一致 |
| 卸载后残留（监听器/watcher/定时器触发） | 360 / 360 / 40 | **0 / 0 / 0** | ✅ |

验证步骤：`npm run preview` → 打开 `http://localhost:4173/?rerun=a` → 面板"场景A"表对比两列；残留探针在卸载后由行为断言自动填充（切换标签页也会触发探针）。

### 验收 2 — 场景 B：交互 INP P95 ≤ 200ms，渲染只含受影响节点

| 指标 | 基线 | 优化 | 判定 |
|------|------|------|------|
| handler 同步段 | 10.2ms | 0.8ms | ✅ |
| 派生重算次数 | 320 | **3**（computed 每 flush 一次） | ✅ |
| watcher 触发次数 | 959（sync 连锁） | **4**（pre/post 批量） | ✅ |
| 行组件渲染次数 | 300（全表） | **48**（=受影响行数） | ✅ |
| stale UI 不一致数 | 0 | 0 | ✅ 功能零变化 |
| LRU 命中/未命中 | 0/0（未启用） | 46/302 | 缓存生效 |
| INP P95（真实点击） | — | **24ms**（21 次交互） | ✅ ≤200ms |

验证步骤：`?rerun=b` 看对比表；INP 需真实点击——切到场景B，手动点"触发扇出"10 次以上，面板"实时指标"行显示 INP P95（event timing，`durationThreshold:16`）。

### 验收 3 — 场景 C：稳态每帧 JS ≤ 8ms@60Hz，丢帧率 <5%，60s 堆不单调增长

| 指标 | 基线 | 优化 | 判定 |
|------|------|------|------|
| flush 轮次 / 4s | 12331 | **240**（≈1/帧） | ✅ |
| 列表渲染次数 / 4s | 12331 | **240** | ✅ |
| 每帧 JS 均值/P95（rAF 差值法） | 0.01/0.10ms | 0.01/0.10ms | ✅ ≤8ms |
| 掉帧率 | 0% | 0% | ✅ <5% |
| 背压丢弃 | 0（无背压） | 0（未超容） | 策略可配 |

验证步骤：`?rerun=c` 看对比表（每列各采样 4s）。**60s 堆内存**：切到场景C 连续运行 60s（堆采样每 2s 一次，Chrome 才有 `performance.memory`），面板"堆内存斜率"应 ≈0 KB/s 且非单调增长；可配合 DevTools Memory 手动 GC 后复核。本次实测 60s：堆 2.6→3.7→2.6→2.9→3.4→3.7MB 振荡（GC 周期），60s 斜率 -0.6 KB/s，非单调增长 ✅。注意：rAF 差值法只统计 rAF 对齐的 JS；基线的病态主要体现在 flush/渲染计数（51×），4x CPU 节流下会进一步表现为掉帧。

### 验收 4 — 回归线

| 项 | 验证步骤 | 判定 |
|----|----------|------|
| 功能行为零变化 | 面板"边界自测"5 项行为断言全过；场景B stale UI 断言 0 处不一致；场景A 任务完成数 360=360 | ✅ |
| `npm run build` | vue-tsc 零错误 + vite build 通过 | ✅ |
| 包体积相对基线零增加 | 优化全部走运行期开关，同一 bundle：`git diff HEAD -- package.json package-lock.json` 为空（零新依赖）；`dist/assets/index-*.js` 93.95 kB（gzip 36.52 kB），开关状态不改变产物 | ✅ |

## 可观测性面板（页面内嵌，非 DevTools）

- **PerformanceObserver**：longtask / event timing（INP P95）/ long-animation-frame，buffered 回放。
- **mark/measure**：场景A 执行段、场景B handler 段。
- **计数器**：组件渲染（onMounted/onUpdated 插桩）、watcher 触发（trackedWatch）、computed 重算（trackedComputed + 基线命令式重算同口径）、flush 轮次。
- **帧监控**：rAF 差值法（帧间隔、掉帧数、每帧 JS）。
- **堆采样**：`performance.memory` 每 2s，最小二乘斜率（Chrome）。
- **一键复跑**：同页面内先全关（基线）再按当前开关各跑一遍，同口径对比。

## 边界自测（行为断言，非硬编码）

`?selftest=1` 或面板按钮：shallowRef 深写无 trigger 静默不更新/triggerRef 后更新/替换更新；watcher pause 期间不触发、resume 补最新值、恢复后依赖仍在；LRU 对象身份键（同内容不同引用不同键）/容量淘汰/版本失效；调度器完成性/取消/错误传播/优先级/分片内写响应式状态重入 flush；背压三策略语义。

更多实现期发现（含对 plan 文档两处结论的证伪与修正建议）见 `docs/implementation-notes.md`。
