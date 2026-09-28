“几百个函数执行”页面性能优化设计方案与技术方案

适用范围：本仓库现状（Vue 3.5.43 + TypeScript + Vite，script setup，客户端渲染，无 vue-router / Pinia 等运行时第三方依赖）。方案不引入任何新的 npm 依赖，不更换框架或构建工具。文中所有 Vue 内部行为均以本地安装的 3.5.43 源码（@vue/reactivity、@vue/runtime-core）为准，Vue 升级大版本时需复核第零章列出的事实点。

零、统一建模：先把“函数执行”映射到 Vue 的真实执行链路

1. 页面上的函数只有四个出处
  1. setup 同步执行体：组件 setup 期间被直接调用的函数，以及 watch/watchEffect 的首次执行（默认 pre 的 watchEffect 在 setup 同步阶段立即跑一次；flush:'post' 的首次执行被推迟）。
  2. 响应式副作用：组件渲染副作用（render effect，其回调叫组件 update job）、computed 的 getter、watch/watchEffect 回调。
  3. 框架外 JS：事件回调、setInterval、requestAnimationFrame、WebSocket/MessageChannel、Promise 回调、第三方 SDK。
  4. 渲染流水线：render 生成 vnode、patch（mount/patchElement/insert）、挂载子组件，以及浏览器侧的 style/layout/paint。
2. Vue 3.5.43 调度事实（后文反复引用，均可在源码中核对）
  1. 响应式写入（ref.value = x）不直接执行副作用，而是调用 dep 上各 subscriber 的 trigger：带 scheduler 的副作用只入队，不执行。
  2. 组件 update job 带 id = instance.uid。queueJob 用标志位 QUEUED(1) 去重，同一组件同一 flush 只入队一次；队列按 id 二分插入（findInsertionIndex），父组件 uid 小于子组件，故父 job 先执行。父组件 render 后若某子组件不再被渲染，该子组件已入队的 job 会被 DISPOSED(8) 标志跳过（源码 flushJobs 中 job.flags & 8 判断）。
  3. 整个 flush 由一个微任务驱动：queueFlush 用 resolvedPromise.then(flushJobs)。flushJobs 执行每个 render job 之前先调 flushPreFlushCbs(instance)，即属于该实例的 pre watcher 在该实例 render 之前执行；所有 render job 执行完后统一 flushPostFlushCbs：post watcher、mounted/updated 钩子、template ref 赋值都在这里。
  4. watch 默认 flush:'pre'：其 job 带 PRE(2) 标志、id=instance.uid，首次运行直接 job()，之后走 queueJob。flush:'post' 走 queuePostFlushCb。flush:'sync' 不挂 scheduler，在响应式写入点同步深度执行。
  5. nextTick 返回 currentFlushPromise.then(fn)，即在当前这一轮 flush 完成后执行；它不是“让出主线程”，只是微任务排队。
  6. computed 是惰性的：依赖变化时只做脏标记传播（propagate），getter 不重算；只有被读取且为脏时才 refreshComputed；3.5 的关键细节是重算后只有 hasChanged(新值, 旧值) 为真才执行 dep.version++ 通知下游，重算结果相同不触发渲染或 watcher。
  7. effectScope.run 期间创建的用户侧 effect/watch/computed 自动被收集，scope.stop() 统一释放；3.5 的 scope 与 watch 返回句柄还带 pause()/resume()。onScopeDispose 注册挂在当前 scope 上的清理回调。
  8. 自触发连锁有 RECURSION_LIMIT = 100 的保护，超限报 “Maximum recursive updates exceeded”，这是症状不是保护网，不能作为设计余量。

一、场景拆解

场景 (a)：页面初始化/挂载阶段集中执行几百个函数

1. 执行链路
  1. createApp(App).mount('#app') 同步触发根组件 renderEffect 首次 run：执行 setup()（同步体）、render() 生成 vnode、patch 挂载 DOM。
  2. patch 遇到子组件递归走 createComponentInstance → setupComponent → 执行子组件 setup()：setup 里直接调用的几百个函数在这里同步跑完；几百个 watchEffect(默认 pre) 也在这里首次执行；几百个 computed 此时只创建不计算。
  3. 子组件首次 render 同步执行并继续向下挂载，整棵树的 setup+render 在一个同步调用栈内完成，中间无法响应输入或绘制。
  4. 全部挂载后进入 post 队列：onMounted 钩子、flush:'post' watcher 的首次回调、queuePostFlushCb 注册的任务在此执行。
2. 瓶颈出现在主线程的哪个环节
  1. scripting 长任务：setup 同步函数本体 + 大量组件实例/vnode 对象创建。即使每个业务函数都不慢，几百个子组件的框架固定开销（instance、vnode、reactive 代理）也可能才是主成本，必须先量化，不能预设“业务函数慢”。
  2. style/layout/paint 被推迟到长任务结束后一次性发生，FP/FCP 被整体推后，TBT 抬升。
  3. mounted/post watcher 中再做几百次写入，会在挂载后立刻触发第二轮 flush（又一次全量 render），出现“挂载完白屏一下再渲染”的双峰。
3. 与响应式系统的交互要点
  1. setup 中同步写入的响应式数据在首次 render 前完成，render 读取到的就是最终值，不会产生额外 job；浪费主要发生在“同步循环里反复写同一 ref”这种写法（虽然 job 去重，但 getter/trigger 本身有成本）。
  2. 在 mounted/post watcher 里写入，必然产生挂载后新的一轮 render job，应尽量把这类写入前移到 setup。

场景 (b)：用户单次交互触发几百个函数连锁执行

1. 执行链路（以一次 click 为例）
  1. 浏览器派发事件，PerformanceEventTiming 开始计时。
  2. 事件 handler 同步执行：直接调用的几百个函数全部在这一段跑完。期间每次 ref 写入都触发依赖：pre watcher 与组件 update 走 queueJob（微任务），sync watcher 在写入点当场执行并可能继续写入，形成深度优先连锁。
  3. handler 返回到微任务检查点，flushJobs 启动：先按实例执行 pre watchers（watcher 里再写入会继续往队列加 job），再按 uid 顺序执行去重后的组件 render job（render+patch），最后执行 post watchers 与 updated。
  4. 微任务清空后浏览器做 style/layout/paint（presentation），本次交互计时结束。
2. 瓶颈出现在主线程的哪个环节
  1. 事件处理同步段过长：直接抬升 INP 的 input 处理时间，也最容易产生 >50ms 的 Long Task。
  2. watch 连锁放大：A 变 → watcher 写 B → watcher 写 C……单层逻辑便宜，层数和扇出相乘后几百个函数变成上千次副作用；sync watch 把这些全部压回 handler 同步段。
  3. render/patch 量：一个顶层 ref 被几百个组件依赖时，job 按组件去重后仍有几百个 render；patch 大 vnode 树的成本往往超过业务函数本身。
  4. 强制同步布局（layout thrash）：handler/watcher 中先读 scrollTop、getBoundingClientRect 再写样式/几何属性，浏览器被迫在 JS 栈内同步排版。
  5. 重复计算：多个 watcher、computed 各自独立遍历同一份几百条数据，且没有共享派生节点。
3. 诊断时必须拆开 INP 的三段：input delay（事件排队，通常是前面有动画/长任务）、processing（handler+flush）、presentation delay（绘制）。“INP 高”不等于“函数慢”。

场景 (c)：高频持续执行（定时器、动画帧、流式推送）

1. 执行链路
  1. setInterval：每个 tick 是一个宏任务，回调写入状态后由微任务 flush 合并同一 task 内的多次写入；但 tick 间隔小于单轮 flush 耗时就持续积压，表现为每 tick 一轮 render、长任务首尾相接。
  2. requestAnimationFrame：帧开始信号。在 rAF 回调里写入状态，微任务 flush 发生在 rAF 之后、浏览器绘制之前，结果当帧上屏；flush 超时则当帧掉帧。
  3. 流式数据（WebSocket message、fetch ReadableStream、EventSource、worker.postMessage）：消息到达节奏不可控，突发 500 条就是 500 个宏任务，每条都可能引发一轮微任务 flush 与 render，框架不会跨宏任务为你去重。
  4. 纯 CSS 动画 / Web Animations API 跑在合成线程，不占主线程；只有 JS 驱动的 rAF 动画才计入本场景。
2. 瓶颈出现在主线程的哪个环节
  1. 每帧预算约 16.7ms（60Hz），扣除浏览器自身工作，JS 安全预算约 8ms；scripting 持续超预算直接表现为连续 Long Task 与 >120ms 的 Long Animation Frame（LoAF），掉帧率上升。
  2. GC 压力：每个 tick 构造新大数组/新闭包，频繁 Minor GC 造成随机毛刺。
  3. 该场景对指标的影响方式不同：它本身不是“交互”，INP 主要通过把后续点击的 input delay 段拉长来恶化；直接指标是帧稳定性（掉帧率、帧间隔 P95）。
  4. 反馈环风险：rAF 回调写状态 → flush 中 post watcher 读取布局再写状态 → 下一轮 rAF，可能触发 ResizeObserver loop 报错或递归更新保护。

二、风险与陷阱清单（“看起来对、实际错或有害”）

1. “把函数本身丢给 Web Worker 就行”
  1. 不成立点：postMessage 传输的是结构化克隆值，不是函数/闭包。一个捕获了组件实例、ref、reactive proxy 的回调根本无法序列化；即使是纯函数，也要把函数体与依赖数据都放进 worker 脚本。
  2. Vue 的响应式系统整体活在主线程，worker 内不能 patch DOM、不能读 DOM 几何信息。
  3. 真正的成本常不在可 offload 的 CPU 计算上：Worker 化后测量，可能发现瓶颈是主线程的 patch/布局，worker 只增加了克隆和通信开销（传输大数组还应考虑 Transferable 转移，转移后主线程侧 ArrayBuffer 立即 neuter）。
  4. 【验证】分别测 Worker 版与同线程版的 performance.measure：worker 版必须把“克隆+通信+回传”时间计入总耗时，对比总端到端时延而非只测 worker 内运算时间。

2. “全量 shallowRef / markRaw 一把梭，响应式更快”
  1. shallowRef 只代理 .value 这一层：state.value.foo 变化不触发依赖。几百个函数里如果有深路径写入而你忘了 triggerRef(state)，结果是静默的视图不更新，这类 bug 在复杂流程里很难复现定位。
  2. markRaw 的对象不会被 reactive() 再包裹，但组件内任何对该对象深属性的更新同样不触发更新；把本应响应式的数据 markRaw 后丢给模板，等于制造“数据变了但页面不动”。
  3. 反过来，对纯展示的巨型常量数据（字典、静态表）不 markRaw，reactive 代理的创建和内存成本也确实存在——这是有条件的正确，不是全量替换。
  4. 【验证】写最小用例断言深路径写入后渲染副作用是否重跑（用 effect(() => { renderSpy = state.value.deep.value }) 计数），并对比 reactive/shallowRef 在目标数据规模下 trigger 次数与耗时（performance.measure 包裹一万次写入）。

3. “computed 是缓存，重逻辑全放 computed 就不会重复算”
  1. 误解一：computed 只在“被读取”时才算。没有任何 effect 读取它，它永远不执行；多个 effect 读取同一个脏 computed，单次 flush 内只重算一次，但若计算期间写入使其依赖多次变化，computed 会再次变脏、下次读取再算。
  2. 误解二：3.5 里 computed 重算结果与旧值相等（hasChanged 为 false）时不做 dep.version++，下游不触发；因此在 computed getter 里做副作用（改外部变量、发请求）是未定义时序的坏味道，副作用可能因“值没变”而不发生。
  3. 误解三：computed 不替代“扇出收敛”。A、B 两个函数各自 computed(() => heavy(raw)) 是两套独立缓存，不会自动共享；要共享必须显式抽出一个共同 computed 节点让两者依赖它。
  4. 误解四：computed 不是免费的，追踪依赖（track/link）和脏检查有固定成本；一行表达式级别的派生值套 computed，调用栈和内存开销反而大于直接计算。
  5. 【验证】在 getter 内计数，模拟依赖变更后不读取/多次读取/写入但结果不变三种情况，验证执行次数与下游 effect 触发次数是否符合预期。

4. “watch 加 flush:'sync'，响应更即时，更快”
  1. 真实代价一：sync watcher 不进队列、不去重、不在渲染前批量执行，而是在每次写入点同步执行。一个 ref 在同步循环里被写 300 次，普通 pre watcher 至多执行 1 次（job 去重），sync watcher 实打实执行 300 次。
  2. 真实代价二：绕开微任务边界，watcher 再写入会深度嵌套触发，交互 handler 的同步段直接膨胀，INP 恶化；还更容易撞 100 次递归更新上限。
  3. 它“更快”的唯一场景：必须在同一调用栈内立即看到派生结果且写入次数极少（例如表单校验链中下一步代码立刻要读结果）。默认 pre（渲染前批量）、需要 DOM 已更新再做事用 post，才是常态选择。
  4. 【验证】同一交互分别用 pre/sync，用 Performance 面板对比事件 task 时长与 watcher 调用次数（watch 回调内计数），以及实际 INP（在慢 4x CPU 下用 web-vitals 记录）。

5. “requestIdleCallback 适合把关键工作让出，交互就不卡了”
  1. 空闲回调的“空闲”指帧与帧之间、或无交互的间隙；交互发生时浏览器并不保证立刻给你让出，且 timeout 参数在繁忙时形同虚设。
  2. 兼容性：Safari 长期不支持 rIC（2024 年才在 Safari 17.4 加入），无依赖项目里没有 polyfill 可用，直接用就是兼容性事故。
  3. 语义错位：关键路径（输入后必须立刻显示的反馈、rAF 驱动动画的更新）用 rIC 会让结果“什么时候出来看浏览器心情”，反而增加时延方差；rIC 只适合可丢弃、可延迟的后台工作（预取、非关键索引构建）。
  4. 让出主线程的正确原语是 rAF（对齐帧）、setTimeout(0)（兜底宏任务）、MessageChannel（任务队列）；要“交还浏览器响应输入”的能力则用 scheduler.yield()（可用 'scheduler' in globalThis 特性检测，不可用降级 MessageChannel）。
  5. 【验证】注入连续合成事件，测量关键反馈从输入到呈现的时延均值与 P95：rIC 方案应在高负载时出现明显长尾与方差，rAF/yield 方案稳定。

6. “上虚拟滚动，函数执行问题就解决了”
  1. 虚拟滚动减少的是 DOM 节点数和挂载/patch 的组件数，不减少你业务函数的执行次数：每行在 setup/computed/watch 里跑的几百个函数，虚拟列表只让“可视区那几十行”跑，非可视区确实不跑——前提是那些函数确实挂在行组件生命周期上。
  2. 如果几百个函数是在数据源上做一次性聚合（与渲染无关），虚拟滚动毫无作用。
  3. 虚拟滚动自身引入成本：滚动时高频 mount/unmount（或回收池），高频滚动场景反而制造更多 setup/patch 函数执行；固定行高、动态行高测量、定位、键盘/无障碍支持都要自己承担，在“演示级项目”里极易过度设计。
  4. 自实现虚拟滚动无第三方依赖可行但工作量不低；先量化“DOM 节点数”是不是主因（Performance 面板中 Recalc Style/Layout 与脚本的占比），节点数在数百以内通常分页/分片渲染就够。
  5. 【验证】对比同数据量下真列表与虚拟列表的滚动帧时长、单帧内 Scripting/Rendering 分项耗时；只有 Scripting 主要来自组件 mount/patch 时虚拟滚动才显示收益。

7. 其他高频错误直觉（一并规避）
  1. “防抖/节流到处加”：debounce 会增加交互响应延迟，节流不改变总工作量只是摊平；输入搜索用 debounce 合理，但把输入受控值的更新也 debounce 会造成受控输入错字感。
  2. “v-once / v-memo 到处加”：v-once 的节点永不更新，绑定动态数据后直接是 bug；v-memo 依赖数组写错（漏依赖）会产生陈旧渲染。
  3. “组件拆得越细渲染越快”：拆分只让更新边界变小（job 按实例去重），但每个实例有固定成本；静态结构拆太细会让场景 (a) 的挂载总耗时上升。
  4. “nextTick 能让出主线程/分片”：nextTick 是微任务，连续 nextTick 循环里浏览器无法绘制、无法响应输入，不构成分片。
  5. “watch 写在组件里随组件销毁自动清理”：对——但在 effectScope 之外、组件 setup 之外创建的 watch（模块级、全局总线回调、手写 addEventListener、setInterval）不会自动清理，SPA 反复进入页面会累积几百个游离副作用，这通常才是“函数越用执行越多”的真实根因。
  6. “Object.freeze 大数组提升渲染”：只有对不需要响应式的数据有意义；冻结了仍被当响应式数据深路径写入的数据，表现为静默不更新（开发环境可能有警告）。
  7. “rAF 循环里直接写业务数据没事”：每帧写多个 ref 虽然 job 去重，但高频数据到达时应先在普通 JS 层聚合/合帧，再一次性 shallowRef 替换；否则几百条流消息=几百轮 flush。

三、分层优化方案

总原则：先分层定位（测量证明热点在脚本、patch 还是布局），再按层下手段；同一类手段只引入一种，避免“分片+worker+虚拟列表”三连叠加。后文所有“更快”均附验证方法，见第四章。

（一）架构层

1. 区分三类函数，分别处置
  1. 纯计算（同输入同输出、无 DOM、无响应式副作用）：可记忆化、可拓扑合并、必要时可 worker 化，是唯一具备 offload 资格的类别。
  2. 派生状态（从响应式状态推导）：用 computed 表达，收敛成共享派生节点，不要在事件里用命令式函数手算后再写入另一个 ref（那等于手写一份会过期的缓存）。
  3. 副作用（改 DOM、发请求、写存储）：归 watch/watchEffect/事件处理器显式管理，统一注册到 effectScope，提供可停止、可暂停的句柄。
2. 写入收敛：交互处理器和流消息处理只改“源状态”，派生结果全部由 computed/watch 推导；一次逻辑动作在一个同步段内完成所有写入，让微任务 flush 天然合并成一轮 render。禁止把一次动作拆进多个 setTimeout 里分别写（那会制造多轮 flush）。
3. 生命周期边界：页面/模块级别的几百个 watcher、定时器、事件总线监听一律在一个 effectScope 内创建，scope.stop() 即统一销毁；DOM 事件监听器在 onScopeDispose 中 removeEventListener，流订阅在 onScopeDispose 中断开。先解决“游离副作用累积”，再谈单次执行提速。
4. 初始化策略：首屏必需数据同步初始化；非必需的几百个初始化函数注册成带优先级的任务（critical：影响首帧；visible：影响首屏但可延后一帧；idle：不可见区域/预计算），按第四章预算逐帧消费。这是策略层，具体调度器见代码层。
5. 数据规模契约：列表类数据在进入响应式系统之前，在普通 JS 层完成 map/filter/sort/聚合，避免在几百个 watcher 里重复遍历；对不可变大数据（静态字典、历史快照）直接 markRaw 或在传入前保持普通对象，不进 reactive。

（二）框架层（Vue 3.5 具体 API 与机制）

1. effectScope 与 onScopeDispose：管理几百个副作用的注册与销毁
  1. 页面根级建一个 scope：const pageScope = effectScope()；pageScope.run(() => { 创建全部 watch/watchEffect/computed })。卸载（演示项目里即组件 unmount 或离开演示视图）调 pageScope.stop()，watch 停止、computed 的依赖订阅断开，避免重复进入时函数数量翻倍。
  2. scope.run 内部的 onScopeDispose(fn) 注册定时器、addEventListener、WebSocket、rAF id 的清理；不要用模块级变量散管。
  3. 3.5 还支持 pageScope.pause()/resume()：被暂停的 scope 内 effect 不再响应 trigger。用于“隐藏页签/折叠区域暂停几百个实时 watcher”，恢复后只补一次计算（适用于场景 c 的暂停推送）。
  4. 【验证】反复 mount/unmount 演示页面 N 次，用 getEffectCount 类调试钩子或在 watcher 回调计数，确认副作用总数不随次数增长；DevTools Memory 拍堆快照对比 detached 监听数。
2. shallowRef + triggerRef 的批量更新模式
  1. 模式一（聚合后整包替换，首选）：本地维护普通数组/对象做累积，一帧或一批结束后 list.value = next（shallowRef 只对 .value 整体替换敏感），一次 trigger、一轮 render。
  2. 模式二（就地修改 + 手动触发）：state.value.items[i].x = 1；改完一批显式 triggerRef(state)。注意这是“手动正确性”模型，要求团队约定所有深路径写入点都必须在批次末尾补 triggerRef，漏一次就是不更新。
  3. 高频流推送标准写法：消息先进普通缓冲区，rAF 回调里 flush：shallowMerge 进当前快照后 triggerRef 一次，保证每帧最多一轮 flush。
  4. 与 v-for 的配合：整包替换会让无 key 或 key 不稳定的列表全量重建，必须配套稳定 key（数据 id，非数组下标）。
  5. 【验证】模拟突发 500 条消息，统计 renderEffect 执行次数：逐 ref 写入应接近 500，合帧替换应为帧数（个位数）；用 performance.mark 标记 flush 起止统计。
3. computed 依赖图：合并重复计算
  1. 把被多处消费的派生（过滤列表、排序结果、聚合统计、按 id 索引 Map）提升为单一 computed 节点，下游 computed/组件只依赖该节点；单次 flush 中该节点最多重算一次（dirty 后惰性重算、值不变不传播，见零章 2.6）。
  2. 链式 computed（raw → filtered → sorted → paged）天然短路：上游重算值不变时 dep.version 不递增，下游连重算都不会发生——但要避免在 computed getter 中写状态/发请求。
  3. computed 内避免生成超大新数组再被多个 effect 全量遍历；先确认计算复杂度本身，computed 只去重次数不降低单次复杂度。
  4. 【验证】getter 计数 + performance.mark：改动一个不影响过滤条件的字段，断言 filtered computed 重算 1 次、sorted 及组件 render 不重跑。
4. watch 的 flush 时机选择
  1. 默认 pre：状态变化后、所属组件 render 前批量执行，且同一轮 flush 内同一 watcher 去重。绝大多数连锁业务逻辑用它。
  2. post：回调执行时 DOM 已 patch 完（post 队列在全部 render job 之后），需要读取更新后的 DOM（测量、滚动到底、初始化依赖真实 DOM 的第三方代码——本项目无此类依赖故主要是前者）时使用。template ref 也在同阶段就绪。
  3. sync：仅限写入次数极少、且同调用栈内立即需要结果的场景（如少量字段的即时联动校验）；几百个函数的批量场景禁用，理由与验证见第二章第 4 条。
  4. 用 watchEffect 只处理“依赖自动收集、无新旧值对比”的副作用；明确 source 与条件触发用 watch。3.5 还可对 watch 句柄做 stop/pause/resume，配合 scope 暂停不可见区域。
  5. 连锁写 watch 要显式画依赖方向（源→派生），禁止两个 watch 互相写对方的源（会被递归上限拦截或长期震荡）。
5. v-memo 与组件拆分：控制 patch 成本
  1. v-memo="[depA, depB]"：命中缓存时该 vnode 子树整段跳过 patch（源码层 memo 数组浅比较，相等则直接复用）。适用于大列表中“每行渲染依赖很多 props、但大多数行大多数更新中不变”的行子树；依赖数组必须包含该行模板实际用到的全部响应式来源，漏项=陈旧 UI。
  2. 组件拆分的收益是更新粒度：父组件一个 ref 变化只重渲染依赖它的子树（job 按实例去重、无 job 的子组件 render 不执行）。把“几百行、每行独立状态”的结构拆成行组件，配合稳定 key，单行更新只产生一个 job。
  3. 拆分的成本是场景 (a) 的实例/挂载开销上升；判断标准：若某块结构静态且不独立更新，不拆；若它在交互中被高频局部更新或需要独立生命周期（自己的 watcher/scope），拆。
  4. v-once 仅用于真静态子树（如本仓库的说明文档区）；v-memo="[]" 等价于一次性缓存，动态数据上禁用。
  5. 【验证】Vue DevTools 组件渲染高亮/计时 + Performance 面板中 patch 相关 self time：改单行数据时，未拆分版本父组件 render 1 次+全量 patch，拆分版本仅行组件 1 个 job；统计实际执行的 render effect 数。
6. 其余框架内手段
  1. markRaw：用于静态字典、永不变化的工具对象、只做命令式操作的第三方实例（本项目暂无），避免 reactive 包装成本；不用于任何模板深依赖的数据。
  2. shallowReadonly：对传入子组件的大对象 props 语义设防意外深改，成本低于深响应（按需，默认不必引入）。
  3. template ref + 指令：需要对几百个 DOM 节点做命令式操作时，优先在 post watcher/onMounted 后集中处理并缓存节点，避免 render 中触碰 DOM。
（三）代码层

1. 分批/分片执行的调度策略
  1. 时间预算：以一帧为外层节拍（rAF），帧内 JS 预算取 8ms（60Hz 目标，给浏览器的 style/layout/paint 留 8ms 以上）；低端机按 4x CPU 降速实测后可收紧到 5ms。交互反馈类（点击立即反馈）先同步执行最小反馈（loading 态/乐观 UI），重活全部转入帧队列。
  2. 基础实现（零依赖）：一个任务队列 + rAF 驱动的 drain：
    - const deadline = （可用 performance.now()）；每帧回调中 while(队列非空 && performance.now() - 帧起点 < 8ms) 执行一个任务单元。
    - 帧内剩余时间不足时，未消费任务留给下一帧；不允许在同一帧内用 while 把队列清空（那就退化成一个长任务）。
  3. 分片粒度如何确定：先按“自然单元”（一个初始化函数 / 一行数据处理 / 一个子任务图节点），再用“执行前采样单元耗时”动态调节：连续单元都很快就每片多取（如 8~16 个），遇到慢单元单片 1 个。起点建议按单单元 P50 耗时估算片大小（8ms / P50 耗时），并设置上限（如每片不超过 64 单元）防止突发。固定“每片 10 个”是最差实践，因为单元耗时方差大时要么过碎要么超时。
  4. 让出原语的取舍：
    - scheduler.yield()（HTML Scheduler API）：yield 后仍按任务优先级尽快回来，浏览器在让出点可以响应输入，最适合连续大计算中“交还输入响应”；用 'scheduler' in globalThis 特性检测。
    - 降级链：scheduler.yield → MessageChannel 宏任务（比 setTimeout(0) 最小 4ms 嵌套钳制更稳定）→ setTimeout(0) 兜底。rAF 让出只适用于“必须逐帧上屏”的可视化进度；纯后台计算用 rAF 会被空标签页的 rAF 节流拖慢，应使用宏任务链。
    - 不要用 nextTick 让出（微任务不让出渲染/输入），不要在关键路径用 requestIdleCallback（理由见第二章第 5 条）。
  5. 与 Vue flush 的协作：每个分片结束后若写了响应式状态，让微任务 flush 自然发生（分片单元边界就是同步栈边界）；即“每片少量写入 → 微任务合并 → 一帧一次绘制”。不要在片内手动 await nextTick() 再继续，那只多排微任务而无视觉收益。
  6. 【验证】Performance 面板录制分片运行：无 >50ms long task；逐帧 Scripting 段稳定 <8ms；总完成时长相对不分片增加不超过 20%。对比 scheduler.yield/MessageChannel 两版的交互 INP（分片进行中持续派发合成点击）。
2. 记忆化（memoization）
  1. 适用对象仅限纯函数；带副作用、依赖时间/随机数/外部可变状态的函数记忆化就是缓存 bug。
  2. 键设计：参数全部可序列化且少（标量或短元组）时用参数直接拼键（如 id + ':' + version）；单对象参数用稳定 id + 数据版本号（version 随整包替换递增），不要 JSON.stringify 大对象做键（键生成本身 O(n)，几百次调用比不缓存还慢）；多参数考虑组合键的基数，基数≈调用数时缓存零命中、纯亏内存。
  3. 失效策略三选一，优先级：
    - 版本失效（首选）：源数据整包替换时 version++，旧缓存整体丢弃，用单层 Map 以 version 为一级键即可天然淘汰。
    - LRU/容量上限：流式/参数空间开放的场景用有上限的 Map（如 1000 条，超出淘汰最早插入），防止内存单调增长。
    - WeakMap 按引用自动回收：键为随组件/批次销毁的对象时用 WeakMap，零手工失效。
  4. 与 computed 的分工：派生状态用 computed（自动参与依赖图、自动惰性/去重）；事件处理、worker 调用参数打包等非响应式上下文的纯函数才用手写 memo。不要在两者之外再发明一套响应式缓存。
  5. 【验证】记录命中率（hit/call），要求热点函数稳定命中率 >80%，否则删除缓存；performance.measure 对比缓存前后调用总耗时；长时间运行后对比堆大小确认无泄漏。
3. 依赖图拓扑排序，避免重复执行
  1. 把“几百个函数”按数据依赖建成有向无环图：节点是纯计算单元，边是“输出被消费”。同批输入到达后按拓扑序执行，每个节点在一个批次内只执行一次，结果供所有下游复用；这正是 computed 依赖图在框架外的等价物——能在响应式层表达的优先用 computed（第 2 节），只有框架外（worker 前预处理、导入管线）才手写。
  2. 禁止环：发现环说明状态边界没切干净（应把环中某个节点改为“命令式显式触发”，而不是让 watch 互相驱动）。
  3. 批处理语义：收集一批输入后一次性注入图（入口节点改值），自顶向下执行受影响子图；未被波及的节点跳过。可与分片调度结合：按拓扑层分片，同层节点无依赖可放入同一片。
  4. 【验证】随机生成 300~500 个节点/边的图，断言每节点每批次执行次数恰为 1；注入单个入口变更，断言仅受影响子图节点执行（记录执行集合）；对比“事件回调里链式手调”版本的总调用数与总耗时。
4. 批量化与防抖动的正确用法
  1. 高频写入优先“合帧”（rAF 缓冲）而非 debounce：合帧保证每帧至少一次上屏，debounce 只在“停止活动后才需要结果”（搜索请求、resize 结束重排）时使用。
  2. throttle 用于有固定可接受频率上限的只读副作用（埋点上报、滚动位置同步），间隔内用最后值（leading/trailing 策略明确写出，不要依赖默认）。
  3. 受控输入值本身不 debounce；debounce 的是输入触发的重计算/请求。

（四）运行时层

1. 何时才应该上 Worker
  1. 必要条件同时满足：纯 CPU 密集（解析/压缩/大规模排序/仿真计算，实测单次要几十毫秒以上）；输入输出可结构化克隆或可转移；计算不依赖 DOM、不依赖 Vue 响应式对象。
  2. 充分性证据：分片+yield 之后仍然产生长任务，且热点 self time 集中在纯函数（Performance 面板确认 patch/布局不是主因）。几百个“小函数”通常不满足——通信与克隆的固定成本会吃掉收益。
  3. 不要用 Worker 做的事：DOM 读写、响应式订阅、需要即时取消且数据巨大的任务（取消可以，但来回克隆已付过费）。
2. 不可序列化闭包的改造
  1. 改造模板：闭包 → 无状态任务函数 + 显式入参。把函数引用的外部变量逐一变成入参字段（如 { type:'aggregate', rows, options }），函数体内只做计算，返回新对象；函数代码随 worker 启动脚本加载（Vite 原生支持 new Worker(new URL('./worker.ts', import.meta.url), { type:'module' })，无需任何新依赖）。
  2. 依赖响应式数据的，先在主线程用 toRaw 取原始对象/普通数组再传入，禁止传 proxy（结构化克隆会触发深层读取甚至抛错）。
  3. 大缓冲（ArrayBuffer）用 transfer 第二参数转移所有权，避免复制；转移后主线程不可再读该缓冲，需要结果回传时由 worker 传回（或用双缓冲轮换）。
  4. 线程数：CPU 密集 worker 上限为 navigator.hardwareConcurrency - 1（留主线程），演示级场景 1 个专用 worker 足够；用任务队列串行化，避免每个任务 new Worker（创建成本高且不受控）。
  5. 生命周期：worker 纳入 effectScope，onScopeDispose 中 post terminate 信号并 worker.terminate()；任务支持单调递增 requestId，过期响应直接丢弃（防止乱序结果覆盖新状态）。
  6. 降级：Worker 不可用（极少数环境）时回落到主线程分片调度器，两者实现同一接口 enqueue(task): Promise<result>。
  7. 【验证】对同一计算量测三端到端时间：同步直算（基线）、主线程分片、worker（含克隆/传输）；只有 worker 版在慢机降速下总时延与主线程长任务数均更优才保留。
3. DOM 与布局层面的运行时手段
  1. 避免 layout thrashing：批量“先全部读、再全部写”几何属性；大量节点测量用 textContent/文档片段离屏构建后一次插入；读滚动与写样式分散在不同帧。
  2. 动画属性限定 transform/opacity（合成线程属性），避免在 rAF 循环里改 width/top 触发 layout；纯视觉动画优先 CSS transition/animation，不占 JS 帧预算。
  3. 大量静态节点可考虑 content-visibility: auto（纯 CSS、零依赖、零框架成本），让屏外长 DOM 的渲染成本延迟到接近视口时支付；这是“减少渲染工作量”而非减少 JS 函数执行，定位准确后使用。
4. 定时器与流的运行时治理
  1. setInterval 轮询改为“自调度 setTimeout/任务队列 + 可见性暂停”：document.visibilitychange 隐藏时停止，恢复时补一次。
  2. WebSocket/流消息统一进缓冲区，由单个 rAF 消费者合帧处理（配合 shallowRef+triggerRef），消息处理函数内禁止直接写几十处响应式状态。
  3. 演示页销毁时，所有 rAF id、timer id、socket 均经 onScopeDispose 释放。

四、可观测性与验证方案

（一）优化前如何定位

1. 先定性属于场景 (a)/(b)/(c) 的哪一种（或混合比例），再决定工具面板与指标，禁止“先上优化再测”。
2. Performance 面板（Chrome/Edge）录制
  1. 开启 CPU 4x/6x 降速录制：场景 (a) 录从导航到可交互；场景 (b) 录一次交互前后 2s；场景 (c) 录 10~20s 持续运行。
  2. Main 轨道看 Long Task（红色角标，>50ms）与 Long Animation Frame（LoAF，>120ms 的动画帧，面板中可看脚本、样式、布局、绘制分项）。
  3. self time 与 total time 的区分（核心方法论）：火焰图中某函数 total time 包含它调用的全部子函数；优化判断只认 self time 大的叶子/近叶子函数。常见误判：flushJobs 的 total time 最大，但它的 self time 近零——它只是调度入口，真正要优化的是其下 render/patch 或某个业务函数的 self time。Bottom-Up 面板按 self time 排序才能找到“几百个函数里真正贵的那几个”。
  4. 按阶段读火焰图：Function Call（业务函数）→ 事件分发或 mountComponent → scheduler flushJobs（pre cbs / component render job / post cbs）→ Rendering（Recalc Style、Layout、Paint）。瓶颈归属一眼可分。
3. performance.mark/measure 代码级埋点（零依赖，可提交到演示页作为实验开关）
  1. 关键段埋点：performance.mark('batch:start') / 执行 / mark('batch:end') / measure('batch', start, end)，再用 performance.getEntriesByType('measure') 汇总均值/P95/P99 与 count。
  2. 典型埋点：事件 handler 起止、flush 前后（可在 watch/postRender 回调间标记）、单片任务起止、worker 发出到结果回传（端到端）、首屏关键初始化函数。
  3. 计次比计时更重要：render 执行次数、watcher 触发次数、computed 重算次数、每帧 flush 次数、缓存命中数——用计数器回答“是不是执行太多次”，用 measure 回答“单次贵不贵”。两类问题的解法完全不同。
4. INP / 交互时延
  1. 用 PerformanceObserver 上报：new PerformanceObserver(list => list.getEntries().forEach(e => ...)) 观察 'event'（PerformanceEventTiming，含 processingStart/processingEnd/duration/cancelable）、'longtask'、'long-animation-frame'。
  2. event 条目的 duration = input delay + processing + presentation；processingStart - startTime 即 input delay，可三段归因。
  3. 不新增依赖地计算 INP：自行维护页面生命周期内所有交互时延的 P98（INP 定义），演示页做一个浮层实时显示即可（正式做法是 web-vitals 库，但本约束不引依赖，自实现约 30 行）。
5. Vue 专属工具
  1. Vue DevTools：组件检查器看更新高亮（交互后哪些组件重渲染——预期之外的高亮即更新边界过大）；Timeline 中 component render 事件带耗时（开发模式 + app.config.performance = true 时 Performance 面板会出现 “Render Frame”、组件 init/render/patch 的用户时间轨，可按组件读耗时）。
  2. 生产构建无开发提示且内联缓存行为不同，所有结论在 vite build 后的 preview 模式复核一次（vue 开发构建的额外警告/堆栈会扭曲耗时）。
6. 内存与游离副作用
  1. DevTools Memory：进入/离开演示页 5 次前后拍堆快照对比，detached 的组件实例、监听器、闭包不应单调增长（定位第二章 7.5 的累积问题）。
  2. watcher/computed 计数：在开发实验分支用 effect/computed 外包包一层计数，确认 scope.stop 后计数回落。

（二）优化后如何证明有效

1. A/B 方法：同一数据集、同一机器、同一浏览器版本、4x CPU，优化前后各跑 10 次取中位数与 P95；差异小于测量噪声（建议阈值 10%）视为无收益，手段回滚。
2. 量化验收标准建议（可按目标设备调整，阈值本身写进验收单）
  1. 场景 (a) 初始化/挂载：
    - 首屏关键路径无 >50ms long task；分片后单帧 JS（self）≤8ms（中低端 4x 降速下 ≤12ms 可接受）。
    - 首帧可交互反馈（首个关键内容渲染完成）相对优化前缩短 ≥30%；TBT（Total Blocking Time，长任务阻塞总和）下降 ≥50%。
    - 全部初始化完成总时长允许上浮 ≤20%（分片的代价），但首屏可见部分必须更早。
  2. 场景 (b) 单次交互：
    - 交互 INP P95 ≤200ms（Google “良好”阈值），目标 P75 ≤100ms；单次交互 processing 段 ≤50ms（无 long task）。
    - 一次交互触发的 render job 数 ≤ 受数据实际影响的组件数（用 DevTools 高亮核对，无整树重渲染）；watcher 调用计数与理论扇出一致，无重复连锁。
    - 无 sync watch 导致的同步段嵌套（Performance 中事件 task 内不出现 watch 触发深栈）。
  3. 场景 (c) 高频持续：
    - 持续运行期间单帧 Scripting ≤8ms、单帧总工作量 ≤16.7ms；掉帧率 <5%（10s 采样，帧间隔 P95 ≤24ms 视为基本流畅，30Hz/60Hz 设备分别换算）。
    - 连续 LoAF（>120ms）数量为 0；>50ms long task 每分钟 ≤2 个。
    - 交互发生在持续动画期间时 INP P95 仍 ≤200ms（input delay 段不被动画长任务抬高）。
    - 隐藏页签后 CPU 占用趋近 0（visibilitychange 暂停生效）；运行 5 分钟堆内存增长 <10%（无缓存/缓冲泄漏）。
  4. 内存与生命周期（三场景共用）：反复进入退出 10 次，watcher/定时器/监听器计数归零，堆快照无单调增长。
3. 回归固化：把计次与 measure 汇总做成一个零依赖的调试面板（挂在 import.meta.env.DEV 下），后续改动若把“每帧 flush 次数”“render 组件数”“交互 P95”打回阈值即视为回归。

（三）每条结论的可证伪约定
  1. 凡方案中出现“更快/更慢/减少执行”的判断，验收时必须同时给出：指标定义（count 还是 duration）、采集方式（PerformanceObserver/mark-measure/DevTools）、对比基线与阈值；达不到即判该手段无效并回滚。
  2. 性能判断不允许以“代码看起来更优”为证据；开发模式与生产 preview 结果冲突时以 preview 为准。

五、取舍与决策表

列含义：收益=预期可量化收益；成本=实现/维护代价；风险=错误使用时的主要故障模式。收益与风险均可按第四章方法证伪。

（一）架构层

1. 函数三分类（纯计算/派生/副作用）
  收益：为所有后续手段提供判定依据，避免对副作用函数误用缓存/Worker；成本：一次性梳理与代码标注，1~2 人日；风险：分类错误（把隐式副作用当纯函数）导致缓存陈旧；适用：全部三类场景的前置工作；不适用：无（这是认知前提，不是可选优化）。
2. 写入收敛（动作内同步写完源状态，派生交给 computed/watch）
  收益：一次动作稳定收敛为一轮 flush，render job 数与“受影响组件数”对齐（计数可验证）；成本：改造现有事件写法，低；风险：需要跨帧的异步流程被强行同步化（这类应显式建模）；适用：场景 (b) 主战场，(a)(c) 同样适用；不适用：确实需要分帧上屏的流式过程（那走合帧，而非多次离散写入）。
3. effectScope 统一生命周期边界
  收益：彻底消除游离 watcher/定时器/监听累积，重复进入页面函数数恒定；成本：每个页面/模块建一个 scope，0.5 人日；风险：scope 边界划错（组件内 watch 已被实例自动收集，无需重复包 scope）；适用：有模块级副作用、反复挂载卸载的页面，直击场景 (c) 与内存问题；不适用：全部 watcher 都在 setup 内且无外部订阅的简单页（收益为零）。
4. 初始化任务分级（critical/visible/idle）+ 逐帧消费
  收益：首屏 FCP/TBT 显著改善（阈值见第四章）；成本：需定义优先级、搭调度器（与 C1 共用），1~2 人日；风险：分级错误导致可见功能延迟出现；适用：场景 (a) 且初始化函数确有几百个；不适用：初始化总量本就 <1 帧预算（先测再定，别为几十个函数上调度框架）。
5. 大数据进入响应式前完成聚合；静态数据 markRaw
  收益：消除深响应代理成本与重复遍历，单次 flush 计时可验证；成本：低，数据入口处约束；风险：把会变的数据误判为静态，视图不更新；适用：静态字典/历史快照/超大列表；不适用：需要深响应的可变业务数据。

（二）框架层

6. shallowRef 整包替换 + 稳定 key（首选模式）
  收益：突发 500 次更新收敛到每帧一次 render（render 计数可验证）；成本：低；风险：key 不稳定导致列表全量重建，收益归零；适用：场景 (c) 流数据、场景 (b) 批量列表更新；不适用：需要细粒度深响应且写入点分散、无法保证批次边界的数据。
7. shallowRef 就地改 + 手动 triggerRef（备选模式）
  收益：保留引用稳定、避免大对象复制；成本：低但依赖团队纪律；风险：漏 triggerRef 即静默不更新，难排查；适用：写入点集中、有明确批次收尾的模块；不适用：写入分散在多人维护的大量调用点（优先用模式一）。
8. computed 依赖图合并派生
  收益：共享派生每轮 flush 至多重算一次，值不变下游零执行（getter 计数可验证）；成本：低，重构现有手算缓存；风险：getter 内夹带副作用、链式环；适用：多函数消费同一份过滤/排序/聚合结果，场景 (b) 最明显；不适用：一次性、无共享、表达式级别的派生（套 computed 反增开销）。
9. watch flush 时机选择（默认 pre / DOM 后 post / 极少 sync）
  收益：pre 自动去重+批量，消除连锁放大；post 保证测量到真实 DOM；成本：无新增成本，是用法校正；风险：误用 sync 导致单交互 watcher 执行数百次（调用计数即可暴露）；适用：所有 watch；不适用：sync 仅适用写入极少且同栈取结果的联动校验。
10. v-memo 缓存大列表行子树
  收益：未变子树整段跳过 patch（patch self time 与渲染计数可验证）；成本：每行维护准确的依赖数组，中；风险：漏依赖产生陈旧 UI；适用：行渲染重、单次更新只涉及少量行的几百行列表；不适用：行模板简单、或每行几乎都变（命中率低，比较成本白付）。
11. 按更新边界拆分子组件（行组件等）
  收益：局部更新只产生 1 个 render job，patch 范围缩小；成本：组件数增加，props 契约与实例固定开销上升；风险：为静态结构过拆，场景 (a) 挂载变慢（挂载计时可证伪）；适用：行/卡片拥有独立状态或高频局部更新；不适用：纯静态、一次性渲染的结构。
12. v-once / markRaw / shallowReadonly 等静态优化
  收益：静态子树 patch 近零成本、对象无代理开销；成本：极低；风险：v-once 绑定动态数据即功能 bug；适用：确证不变的说明区、字典、props 防写；不适用：任何会变的数据。
13. scope/watch 的 pause/resume（3.5）
  收益：隐藏区域几百个 watcher 完全不响应 trigger，恢复后补算一次；成本：低（API 内建）；风险：暂停期间 UI 与数据语义需有“恢复即一致”的保证；适用：场景 (c) 的页签/折叠/不可见实时面板；不适用：始终可见、要求持续实时的区域。

（三）代码层

14. rAF 帧队列分片（8ms 预算，帧边界自然 flush）
  收益：消灭 long task，首屏与交互期间输入可响应（long task 数 + INP 可验证）；成本：中，需要队列、取消、优先级；风险：任务有隐式顺序依赖时跨片出错（须配合 C18 或保证单元独立）；适用：场景 (a) 初始化分片、场景 (b) 重活延迟执行；不适用：总量 <1 帧预算（纯属复杂度）。
15. 动态分片粒度（采样单元耗时，自适应片大小+上限）
  收益：单元耗时方差大时仍稳定不超时；成本：在 C14 之上增加少量采样逻辑；风险：自适应逻辑自身引入抖动（须做上限钳制）；适用：任务单元耗时不均的初始化/处理管线；不适用：单元同质且极轻（固定小批即可）。
16. scheduler.yield 让出 + MessageChannel/setTimeout 降级链
  收益：连续计算中交还输入响应，降级保证全浏览器可用（无新依赖）；成本：中，需特性检测与两条路径测试；风险：降级路径行为差异、让出点过多使总时长上升；适用：不可切片为帧、但需保输入响应的后台长计算；不适用：已用 rAF 合帧且总量可控的可视化任务（rAF 边界已是让出点）。
17. 纯函数记忆化（版本失效 / 有界 LRU / WeakMap 三选一）
  收益：热点重复输入下调用成本骤降（命中率+耗时可验证）；成本：低到中，键设计与失效策略需评审；风险：非纯函数被缓存、键 O(n) 生成、缓存无界导致内存增长；适用：入参基数小、重复率高的解析/查表/聚合；不适用：每次输入都不同（命中率低）或函数带副作用。
18. 依赖图拓扑执行（每节点每批一次）
  收益：框架外管线的调用数降到理论下限（执行集合断言可验证）；成本：高，需建图、调度、环检测；风险：过度工程、图与真实依赖漂移；适用：worker 前预处理/导入管线等响应式之外的几百步计算；不适用：依赖关系能直接用 computed 表达的场景（用 F8，不手写图）。
19. 合帧（rAF 缓冲）优先于 debounce/throttle
  收益：既限制每轮 flush 数又不牺牲逐帧反馈；成本：低；风险：把“停止后才执行”的需求误用合帧（应 debounce）；适用：流式消息、滚动联动值；不适用：搜索请求等静止后语义（debounce）、固定频率上报（throttle）。

（四）运行时层

20. Web Worker offload 纯重计算（模块 worker，Vite 原生）
  收益：纯计算移出主线程，主线程 long task 与 INP 直接改善（端到端对比可证伪）；成本：高，任务协议、序列化、取消、降级、双端调试；风险：克隆/通信成本超过计算本身、proxy 误传、过期响应覆盖；适用：单次几十毫秒以上的纯 CPU 任务；不适用：几百个小函数（固定通信费吃掉收益）、DOM/响应式相关逻辑。
21. 闭包改造为“无状态函数+显式入参”，toRaw 后传入、transfer 转大缓冲
  收益：使 Worker 成为可能，大缓冲零拷贝；成本：中高，接口数据化改造；风险：所有权转移后误用已 neuter 缓冲、入参漏传造成隐式依赖；适用：确定走 F20 的任务；不适用：不做 Worker 即无需改造。
22. 布局读写分离、离屏片段插入、transform/opacity 动画
  收益：消除 layout thrashing 与每帧 layout，Rendering 段计时可验证；成本：低；风险：低；适用：场景 (b)(c) 中触几何属性的代码；不适用：纯数据处理、无 DOM 操作的页面。
23. content-visibility: auto 延迟屏外渲染
  收益：长静态页面首屏渲染工作量下降（零依赖一行 CSS）；成本：极低；风险：滚动到边缘时的跳变、滚动条高度测量需 contain-intrinsic-size 配合；适用：几百个静态区块的长页面；不适用：短页面、虚拟列表已覆盖的场景。
24. 定时器/流消息合帧 + 可见性暂停 + 统一释放
  收益：场景 (c) 每帧最多一轮 flush，隐藏时 CPU 趋零；成本：中，缓冲区与生命周期改造；风险：暂停/恢复时的状态补发语义；适用：所有定时器、WebSocket、rAF 循环；不适用：低频（秒级以上）且天然合并的简单轮询。
25. 性能埋点与零依赖调试面板（mark/measure + PerformanceObserver 计数）
  收益：让上述全部收益可证伪、可回归；成本：1~2 人日；风险：开发/生产计时差异（结论以 preview 为准）；适用：贯穿全部场景；不适用：无（这是验收基础设施，应最先做最小版本）。

（五）演示级项目的取舍边界：哪些是过度设计

1. 本项目应实现（低成本高确定性收益，且正好作为演示）
  1. 函数三分类与写入收敛（1、2），effectScope + onScopeDispose 生命周期治理（3、6 合一处演示）。
  2. computed 依赖图合并（8）、watch flush 时机规范化（9）、按更新边界拆分组件（11）。
  3. shallowRef 合帧更新（6）、rAF 分片调度器最小版（14，固定预算即可，不必做自适应完整版）。
  4. 合帧/防抖/节流的正确分工（19），布局读写分离（22），content-visibility（23），可见性暂停与统一释放（24）。
  5. 最小可观测面板（25）：long task、交互 INP 自算 P98、render/watcher 计数、帧预算曲线。
2. 只做“方案级演示”，不建议在演示项目里做生产实现
  1. Worker 全链路（20、21）：用一个孤立 demo 任务演示“纯计算 offload + 端到端对比”即可；任务协议、取消、降级、缓冲池不做生产化。
  2. 动态自适应分片（15）、scheduler.yield 完整降级链（16）：演示固定预算分片与一次 yield 让出即可，不做多策略调度框架。
  3. watcher 的 pause/resume（13）：做一个页签暂停的演示开关，不内建进架构。
  4. 记忆化（17）：演示版本号失效一种策略即可，不实现通用 LRU 缓存库。
3. 在本约束下判定为过度设计、明确不做（仅保留设计与验证方法）
  1. 虚拟滚动：几百行规模先由分片渲染 + key + 组件拆分覆盖；只有当 Performance 证明 Rendering（而非业务 JS）是主因且行数扩到数千时再立项。
  2. 通用 DAG 拓扑执行引擎（18）：响应式内的去重用 computed，框架外管线在演示中不存在；只保留设计与验证用例。
  3. 多 Worker 池/抢占式优先级调度/自研协程：无对应业务负载，属于为不存在的瓶颈写框架。
  4. requestIdleCallback 方案：语义与兼容性双不满足，不做。
4. 建议实施排期（演示迭代，约 7~9 个工作日）
  1. 第 1 天：埋点与调试面板最小版（25），录三条场景基线，出热点归属。
  2. 第 2~3 天：架构层 1/2/3/5 + 框架层 8/9/11，回归计次指标。
  3. 第 4~5 天：合帧与 shallowRef 模式（6、19、24）+ 分片调度器（14），攻场景 (a)(c)。
  4. 第 6 天：Worker demo 与 pause/resume 开关（20/21/13，演示级），不进生产路径。
  5. 第 7 天：按第四章阈值在 4x CPU + preview 构建下做 A/B 验收，未达阈值或收益 <10% 的手段回滚。
  6. 缓冲 1~2 天：处理验收中暴露的顺序依赖与边界问题。
