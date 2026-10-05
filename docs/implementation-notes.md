# 实现 notes（演示级约束下的边界与证据）

本文件记录落地过程中发现的、与 `docs/performance-plan.md` 手段相关的边界问题与处置。
文档已有结论均未改动；以下为实现期证据与修正建议。

## 1. computed 透传 shallowRef 数组会吞掉 triggerRef（已修复，真实 bug）

- **现象**：场景 C 初版用 `computed(() => flags.shallow ? optList.value : baseList)` 透传列表。
  就地改 + `triggerRef(optList)` 后，computed 重算得到**同一数组引用**，按 3.5 语义
  `hasChanged=false` 不做 `dep.version++`，下游渲染副作用不被通知 → 静默不更新。
  正是文档零章 2.6 预言的行为，在演示中真实复现（C1 边界用例 1 当场捕获：补 triggerRef 后 DOM 仍缺失）。
- **修复**：模板渲染期直接读 `visibleList()`（普通函数），让渲染副作用直接依赖 `optList`，
  不经过 computed 透传。见 `src/scenarios/scenarioC/ScenarioC.vue`。
- **修正建议（手段 3 使用约束）**：shallowRef+triggerRef 批量模式的读取路径上，
  禁止夹一层“原样返回同一引用”的 computed；派生必须产生新值（过滤/映射/聚合）才可经 computed。

## 2. 计数探针在渲染期读响应式计数器会自触发死循环（已修复）

- **现象**：`count()` 初版实现 `counters[name] = (counters[name] ?? 0) + by`，
  在模板渲染期间调用（渲染计数探针）时，读取被当前渲染副作用追踪，写入又触发自身 → 无限渲染循环，
  切到场景 C 页面即卡死（CDP Debugger.pause 抓到 `runIfDirty → run` 循环栈）。
- **修复**：读取走 `toRaw(counters)`，写入仍走代理（面板保持响应式）。见 `src/perf/metrics.ts`。
- **启示**：凡“在 render 期间执行的探针/埋点”，不得经响应式代理读自身会写的状态。

## 3. 合成事件不计入 Event Timing（验收口径说明）

- 规范上 PerformanceEventTiming 只上报 **trusted** 事件，`element.click()` / CDP 派发的合成点击不产生条目。
- 因此自动复跑（面板“复跑对比”与 `scripts/smoke.mjs`）的交互时长采用手动口径：
  handler 起点 `performance.now()` → 双 rAF（呈现完成），记为“交互总时长”。
- 验收表 INP P95 ≤ 200ms 需**真实手动点击**后读面板“INP P95(B场景)”，该值来自 event timing 观察者。

## 4. 长任务窗口采用重叠语义

- 基线场景 A 的挂载长任务在点击任务内开始（起点早于测量窗口 t0），按“起点在窗口内”过滤会漏计。
- `longTasksInWindow` 改为重叠判定（`start+duration > t0 && start < t1`）。见 `src/perf/metrics.ts`。

## 5. “帧 JS 耗时（rAF 差值法）”的覆盖范围有限（口径说明）

- 该探针测量 rAF 回调起点到紧随微任务结束的窗口，能覆盖 rAF 内写入引发的 Vue flush；
  但场景 C 基线的 flush 发生在各 MessageChannel 宏任务自身的微任务检查点，不在该窗口内。
- 因此场景 C 的主指标以**丢帧率、长任务数、LoAF、渲染计数**为准（这些明确区分基线/优化），
  帧 JS P95 作为辅助。未删改该探针，口径在此注明。

## 6. 环境相关能力（面板“采集能力”行实时显示）

- `performance.memory`（60s 堆验证）仅 Chrome 系；headless 环境可能恒为 0，此时以 DevTools Memory 复核。
- `long-animation-frame` 仅 Chrome 系；`scheduler.yield` 需 Chrome 129+，不可用时调度器自动降级
  MessageChannel → setTimeout(0)（面板显示实际让出原语）。

## 7. 场景 A 优化后总完成时长上浮（符合文档预期）

- 实测（headless Chromium，本机）：基线挂载同步段 ~81ms（1 个长任务），优化后 ~11ms；
  全部 320 任务完成总时长 ~97ms → ~195ms（上浮 ~2x，高于文档“≤20%”的参考值）。
- 原因：演示任务单元极小（~0.25ms），分片的帧边界让出成本占比被放大；文档该阈值面向真实业务任务。
- 验收指标（首屏无 >50ms Long Task）达成；总时长上浮不影响交互响应性，判定可接受，在此备案。

## 8. 包体积口径

- 9 项手段与基线代码同包、开关为运行时切换，启停优化对产物体积影响恒为 0；
  `package.json` dependencies 相对模板零新增（仅 vue@3.5.43）。
  当前产物 `dist/assets/index-*.js` ≈ 100.5 kB（gzip ≈ 39 kB）。
