# 实现笔记：plan 文档结论在演示级约束下的验证与修正

按要求未改动 `docs/performance-plan.md`。以下为实现与实测中发现的不成立点/补充点，附证据与修正建议。测量环境：headless Chromium 1243（Linux，无 CPU 节流），`npm run preview` 生产构建，`?rerun=*` 自动复跑采集。

## 1. 分片调度"总时长上浮 ≤20%"对 CPU 密集初始化不成立（场景 A）

- **文档结论**（第四章）："全部初始化完成总时长允许上浮 ≤20%（分片的代价）"。
- **实测**：场景 A 任务执行段耗时 基线 103.7ms → 分片优化 212.2ms（**+105%**）。
- **分析**：8ms 预算 / 16.7ms 帧长 ⇒ 分片吞吐量上限 ≈ 48%，CPU 密集型批量总时长理论下界 ≈ 串行耗时 × 16.7/8 ≈ **+109%**，与实测吻合。≤20% 只在"任务量远小于帧预算"或"帧间本就有空闲"时成立。
- **修正建议**：把验收表述改为"CPU 密集批量最坏约 2×（由预算/帧长比决定），首屏可交互时间与 Long Task 数仍改善"；或按优先级让 critical 任务同步执行、仅 visible/idle 分片（本仓库任务已带优先级，可直接支持）。首屏无 >50ms Long Task 的硬指标不受影响（实测 基线 1 个 108ms → 优化 0）。

## 2. triggerRef 会被"身份缓存层"吞掉：computed hasChanged 与子组件 props 浅比较（场景 C）

- **文档结论**（第二章 2.4）：shallowRef 就地改漏 triggerRef 会静默不更新——成立，但**即使调了 triggerRef 也可能不更新**，文档未覆盖这一层。
- **实测**：场景 C 优化态初版用"就地 push + triggerRef"，面板显示列表渲染次数 = 0（预期 ≈240/4s）。原因有两层：
  1. 中间隔一个返回同一数组引用的 `computed`：triggerRef 使其重算，但返回值引用相同 → `hasChanged=false` → 不通知下游（正是文档第零章 6.6 的 3.5 行为）。
  2. 子组件 props 浅比较：父组件重渲染后传下去的仍是同一数组引用 → 子组件跳过更新。
- **修复**：列表组件改为接收 ref 本身、渲染效应直接订阅 shallowRef（triggerRef 穿透组件边界）；统计 watcher 改为 watch 原始值派生（长度+校验和），绕开引用身份。修复后实测 列表渲染 240 次/4s、flush 240 轮/4s。
- **修正建议**：文档第二章 2.4 补充——"triggerRef 只能唤醒**直接订阅该 ref** 的效应；中间任何按引用判等的缓存层（computed、props 浅比较、v-memo）都会把它吞掉。跨层传递时要么传 ref 让末端订阅，要么整包替换给新引用"。

## 3. event timing 默认 durationThreshold=104ms，快速交互不上报（INP 采集）

- **文档结论**（第四章）：用 PerformanceObserver 观察 'event' 计算 INP——方向对，但缺一个关键参数。
- **实测**：默认阈值下 handler 1~12ms 的交互**一条都不上报**（面板显示 0 次交互）。显式 `durationThreshold: 16`（规范允许最小值）后，21 次真实点击全部采集，INP P95 = 24ms。
- **修正建议**：第四章 4.2 补充"`observe({type:'event', durationThreshold:16})`，否则只能看到 >104ms 的交互，INP P95 会系统性偏乐观（只剩坏样本）"。

## 4. rAF 在节流/无帧环境不触发，调度器需要超时兜底（手段 7）

- **文档结论**（第三章 C16）：让出链 scheduler.yield → MessageChannel——成立，但只覆盖"让出"，没覆盖"帧边界等待"。
- **实测**：headless/隐藏页签下 rAF 不回调，纯 rAF 驱动的分片循环**永久停摆**（场景 A 优化态任务完成数 0/360，被复跑对比直接暴露）。
- **修复**：帧边界改为 `Promise.race([rAF, setTimeout(64ms)])`，`document.hidden` 时直接走 MessageChannel 让出链。修复后 360/360 完成。
- **修正建议**：第三章 C14/C16 补充"rAF 等待必须有超时兜底；隐藏页签应走宏任务让出链而非空转"。

## 5. 其余文档结论的实测复核（均成立，未改动）

- watch flush:sync 放大：基线 watcher 触发 959 次/扇出 vs pre/post 4 次（文档第二章 4.1 量级吻合）。
- computed 合并派生：派生重算 320 → 3 次/扇出（第三章 F8 成立）。
- v-memo：行渲染 300 → 48（=实际受影响行数），stale UI 断言 0 不一致（依赖数组 = 模板读取的全部可变字段 [value, status, score, delta]）。
- effectScope 统一治理：基线卸载后残留 360 监听器 / 360 watcher / 40 定时器触发，优化态全 0（行为探针断言，非静态检查）。
- 流聚批+背压：flush 12331 → 240 轮/4s（≈每帧 1 轮），渲染频率封顶帧率成立。

## 6. 调度器 v2：双队列（帧 rAF / 后台宏任务）、可见性迁移、慢任务同源降级

本轮把手段 7 的单队列分片调度器改造为双队列，**对外 API 与既有面板口径保持兼容**（`schedule/cancel/done/cancelAll/whenIdle/dispose`、`pending/executed/errors/avgTaskMs` 全部保留；仅新增只读指标与 `TaskHandle.getPriority()`）。

- **队列拆分**：`critical/visible` 进帧预算队列（rAF 对齐 + 8ms 预算 + EMA 自适应片大小）；`idle` 进后台宏任务队列，由 `scheduler.yield() → MessageChannel → setTimeout(0)` 降级链驱动。可见时帧切片排空帧队列后若仍有预算，会 park 捎带宏任务队列中的 idle——这是为了**保持 v1 总序**（任何 critical/visible 先于 idle、同级 FIFO）。场景 A 存在 `idle` 依赖前序 `visible`（i%4 链），若改成严格两队列并行（idle 在 rAF 之间的宏任务里抢先跑）会破坏拓扑序，park 捎带在不削功能的前提下规避了该回归。
- **可见性迁移**：`document.visibilitychange` hidden 时帧队列所有待执行任务迁入宏任务链（rAF 在隐藏页签不触发）；visible 时带迁移标记的任务按**当前有效优先级**迁回（被慢降级为 idle 的不再回帧队列，原生 idle 永不回）。迁移只改驻留队列，不改任务状态机：`cancel()` 对待执行任务立即出队并 settle `done`（已取消迁移后仍不执行、`done` 仍 resolve）；执行中任务不可抢占（与 v1 一致）。
- **慢任务降级**：单任务墙钟 > 3ms 记 `slow`，同一批次（一次帧切片）内仍在排队的**同源**后继（按新增的可选 `task.source` 归并）有效优先级降一级：critical→visible（帧队列内重排）、visible→idle（移入宏任务链）。异源任务、下一批次新任务不受影响（selftest 第 8 组以 `demotions===1` 行为断言锁定）。
- **面板口径**：仅在"实时指标"新增一行只读 `v2 慢任务计数 / 同源降级次数 / 可见性迁移次数`（全局 `schedulerStats`），**未改动**任何既有指标定义与三场景验收字段；故验收表数字口径无变化。本轮复测场景 A `?rerun=a`：基线 1 个 >50ms Long Task、优化 0、任务完成 360/360、卸载后残留监听器 0，与 v1 结论一致。
- **证据（headless Chromium 153，无节流，`?selftest=1`，连续 3 次）**：9 组边界断言全绿；其中场景 C 全开对账 10s 实测 `帧≈600、flush≈601（预算 帧×1.2≈720）`、产出约 3.1 万条消息、双管线 dropped=0/0、终态 seq 与参照管线逐条一致、丢弃+100 条列表窗口可完整解释未出现的 seq。
