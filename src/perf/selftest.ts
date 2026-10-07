import { ref, shallowRef, triggerRef, watch, watchEffect, nextTick } from 'vue'
import { memoize } from './lru'
import { createScheduler, frameBoundary } from './scheduler'
import { createStreamBuffer } from './stream'
import { createSources, type StreamMsg } from '../scenarios/c/sources'
import { createOptimizedState, createBatchedWriter, LIST_CAP } from '../scenarios/c/optimized'

/**
 * 边界用例行为断言：全部基于真实响应式行为，不允许硬编码结果。
 * 每个用例返回 { name, pass, detail }。
 */

export interface SelfTestResult {
  name: string
  pass: boolean
  detail: string
}

export async function runSelfTests(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const push = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail })
  }

  /* 1. shallowRef + triggerRef：漏 trigger 的静默不更新必须可观测 */
  {
    const s = shallowRef({ nested: { v: 0 } })
    let runs = 0
    const stop = watchEffect(() => {
      void s.value.nested.v
      runs++
    })
    const afterMount = runs
    s.value.nested.v = 1 // 深路径写入，不 trigger
    await nextTick()
    const silentOk = runs === afterMount // 断言：确实静默不更新（这是要规避的坑）
    s.value.nested.v = 2
    triggerRef(s) // 批量收尾手动触发
    await nextTick()
    const triggeredOk = runs === afterMount + 1
    s.value = { nested: { v: 3 } } // 整包替换自动触发
    await nextTick()
    const replacedOk = runs === afterMount + 2
    stop()
    push(
      'shallowRef/triggerRef 边界',
      silentOk && triggeredOk && replacedOk,
      `深写无trigger不更新=${silentOk} triggerRef后更新=${triggeredOk} 替换更新=${replacedOk} (runs=${runs})`,
    )
  }

  /* 2. watcher pause/resume：恢复后不丢依赖 */
  {
    const src = ref(0)
    const seen: number[] = []
    const h = watch(src, (v) => seen.push(v))
    src.value = 1
    await nextTick()
    h.pause()
    src.value = 2
    src.value = 3
    await nextTick()
    const pausedOk = seen.length === 1 // 暂停期不触发
    h.resume()
    await nextTick()
    const resumedOk = seen.length === 2 && seen[1] === 3 // 恢复补一次最新值
    src.value = 4
    await nextTick()
    const aliveOk = seen.length === 3 && seen[2] === 4 // 依赖未丢
    h()
    push(
      'watcher pause/resume',
      pausedOk && resumedOk && aliveOk,
      `暂停不触发=${pausedOk} 恢复补最新=${resumedOk} 恢复后仍响应=${aliveOk} seen=[${seen.join(',')}]`,
    )
  }

  /* 3. LRU：对象身份键、淘汰顺序、版本失效 */
  {
    let calls = 0
    const f = memoize((o: { a: number }, k: number) => {
      calls++
      return o.a + k
    }, { maxSize: 2 })
    const o1 = { a: 1 }
    const o2 = { a: 1 } // 同内容不同身份：JSON.stringify 会误判同键
    f(o1, 1)
    f(o2, 1)
    const identityOk = calls === 2 && f(o1, 1) === 2 && calls === 2
    const o3 = { a: 1 }
    f(o3, 1) // 容量 2：淘汰最久未用 (o2,1)，o1 因刚命中而保留
    const callsBefore = calls
    const hitOk = f(o1, 1) === 2 && calls === callsBefore // o1 仍命中
    f(o2, 1)
    const evictedOk = calls === callsBefore + 1 // o2 被淘汰 → 重算
    let ver = 0
    const vf = memoize((x: number) => x * 2, { version: () => ver })
    vf(5)
    const vMissBefore = vf.misses
    ver = 1 // 版本换代 → 整体失效
    vf(5)
    const versionOk = vf.misses === vMissBefore + 1
    push(
      'LRU 记忆化键与失效',
      identityOk && evictedOk && hitOk && versionOk,
      `对象身份键=${identityOk} LRU淘汰=${evictedOk} 命中保持=${hitOk} 版本失效=${versionOk}`,
    )
  }

  /* 4. 调度器 v1 口径：完成性、优先级、取消、错误传播、重入 flush */
  {
    const order: number[] = []
    const errs: unknown[] = []
    const sched = createScheduler({ frameBudgetMs: 8, onError: (e) => errs.push(e) })
    for (let i = 0; i < 40; i++) {
      sched.schedule({ priority: 'idle', run: () => { order.push(i) } })
    }
    const cancelled = sched.schedule({ priority: 'idle', run: () => { order.push(999) } })
    cancelled.cancel()
    sched.schedule({ priority: 'idle', run: () => { throw new Error('boom') } })
    sched.schedule({ priority: 'critical', run: () => { order.push(-1) } })
    await sched.whenIdle()
    const completeOk = order.filter((n) => n >= 0 && n < 40).length === 40
    const cancelOk = !order.includes(999)
    const errorOk = errs.length === 1
    const priorityOk = order[0] === -1 // critical 插队到最前

    // 重入 flush 边界：分片任务内写响应式状态并 await nextTick
    const src = ref(0)
    let stage = 0
    let flushCount = 0
    const stopWatch = watch(src, () => flushCount++)
    const s2 = createScheduler({ frameBudgetMs: 8 })
    s2.schedule({
      priority: 'critical',
      run: async () => {
        src.value = 1
        await nextTick() // 等 Vue flush 重入完成
        stage = 1
        src.value = 2
        await nextTick()
        stage = 2
      },
    })
    await s2.whenIdle()
    stopWatch()
    const reentrantOk = stage === 2 && flushCount === 2 && src.value === 2
    push(
      '分片调度器边界',
      completeOk && cancelOk && errorOk && priorityOk && reentrantOk,
      `完成=${completeOk} 取消=${cancelOk} 错误传播=${errorOk} 优先级=${priorityOk} 重入flush=${reentrantOk}`,
    )
  }

  /* 5. 流缓冲背压：三种丢弃策略语义 */
  {
    const b1 = createStreamBuffer<number>(3, 'drop-oldest')
    b1.pushBatch([1, 2, 3, 4, 5])
    const oldestOk = b1.drain().join(',') === '3,4,5' && b1.dropped === 2
    const b2 = createStreamBuffer<number>(3, 'drop-newest')
    b2.pushBatch([1, 2, 3, 4, 5])
    const newestOk = b2.drain().join(',') === '1,2,3' && b2.dropped === 2
    const b3 = createStreamBuffer<number>(3, 'unbounded')
    b3.pushBatch([1, 2, 3, 4, 5])
    const unboundedOk = b3.drain().length === 5 && b3.dropped === 0
    push(
      '流缓冲背压策略',
      oldestOk && newestOk && unboundedOk,
      `丢最旧=${oldestOk} 拒最新=${newestOk} 不丢弃=${unboundedOk}`,
    )
  }

  /* 6. 双队列路由 + 可见性迁移（任务只在两队列间移动，状态语义不变） */
  {
    const sched = createScheduler({ frameBudgetMs: 8 })
    sched.setHiddenForTest(false)
    const c = sched.schedule({ priority: 'critical', run: () => {} })
    const v = sched.schedule({ priority: 'visible', run: () => {} })
    const i = sched.schedule({ priority: 'idle', run: () => {} })
    const routeOk = sched.framePending === 2 && sched.macroPending === 1
    const queuedOk = sched.pending === 3 && sched.executed === 0

    // 隐藏：帧队列 2 个任务迁入宏队列
    sched.setHiddenForTest(true)
    const hideOk = sched.framePending === 0 && sched.macroPending === 3 && sched.migrations === 2
    // 隐藏期间新入帧级任务直接进宏链
    const h = sched.schedule({ priority: 'critical', run: () => {} })
    const enqueueHiddenOk = sched.macroPending === 4
    // 恢复可见：critical/visible（c/v/h 共 3 个）迁回，idle（i）留后台
    sched.setHiddenForTest(false)
    const showOk = sched.framePending === 3 && sched.macroPending === 1 && sched.migrations === 5

    await sched.whenIdle()
    const allDone = await Promise.all([c.done, v.done, i.done, h.done]).then(() => true)
    const execOk = sched.executed === 4
    sched.dispose()
    push(
      '双队列路由与可见性迁移',
      routeOk && queuedOk && hideOk && enqueueHiddenOk && showOk && allDone && execOk,
      `路由帧2/宏1=${routeOk} 隐藏迁宏3=${hideOk} 隐藏入队进宏=${enqueueHiddenOk} 恢复迁帧3留idle1=${showOk} 全部done=${allDone} 执行${sched.executed}/4`,
    )
  }

  /* 7. 慢任务降级：>3ms 记 slow，同批次后继同源任务降一级；对照组证明非硬编码 */
  {
    // 实验组：visible 慢任务 → 后继 visible 降到 idle 级（移交后台宏队列）
    const slowOrder: string[] = []
    const s1 = createScheduler({ frameBudgetMs: 20 })
    s1.setHiddenForTest(false)
    s1.schedule({ priority: 'idle', run: () => { slowOrder.push('idle-a') } })
    s1.schedule({
      priority: 'visible',
      run: () => {
        const t0 = performance.now()
        while (performance.now() - t0 < 5) { /* >3ms 慢任务 */ }
        slowOrder.push('slow')
      },
    })
    s1.schedule({ priority: 'visible', run: () => { slowOrder.push('visible-after') } })
    await s1.whenIdle()
    const slowIdx = slowOrder.indexOf('slow')
    const afterIdx = slowOrder.indexOf('visible-after')
    const idleIdx = slowOrder.indexOf('idle-a')
    // 降级后 idle-a 与被降级的后继同属宏队列，FIFO 下 idle-a 先执行
    const demoteOk = s1.slowTasks === 1 && slowIdx < idleIdx && idleIdx < afterIdx

    // 对照组：同样任务但全部极快（无 slow）→ visible 整体先于 idle
    const fastOrder: string[] = []
    const s2 = createScheduler({ frameBudgetMs: 20 })
    s2.setHiddenForTest(false)
    s2.schedule({ priority: 'idle', run: () => { fastOrder.push('idle-a') } })
    s2.schedule({ priority: 'visible', run: () => { fastOrder.push('fast') } })
    s2.schedule({ priority: 'visible', run: () => { fastOrder.push('visible-after') } })
    await s2.whenIdle()
    const controlOk = s2.slowTasks === 0 && fastOrder.indexOf('idle-a') === 2
    s1.dispose()
    s2.dispose()
    push(
      '慢任务降级(>3ms)',
      demoteOk && controlOk,
      `slow组=[${slowOrder.join(',')}] slow=${s1.slowTasks} 对照组=[${fastOrder.join(',')}] 降级=${demoteOk} 对照=${controlOk}`,
    )
  }

  /* 8. 分片内 shallowRef(triggerRef) 写 + pause/resume watcher：更新不丢、无递归超限、每帧 flush ≤ 2 */
  {
    const data = shallowRef<number[]>([])
    const applied: number[] = []
    let watcherRuns = 0
    // 数据 watcher 只做快照读取（不在回调里写 data），天然无递归环；
    // 若回调在同一 flush 内被同步重入则记递归超限。
    let syncReentries = 0
    let inCallback = false
    const h = watch(
      data,
      (arr) => {
        if (inCallback) syncReentries++
        inCallback = true
        watcherRuns++
        applied.length = 0
        applied.push(...arr)
        inCallback = false
      },
      { deep: false },
    )

    const WRITE_N = 24
    const sched = createScheduler({ frameBudgetMs: 8 })
    sched.setHiddenForTest(false)
    // pause 作为分片第 1 个任务：前 8 个写入在暂停期发生（不丢，只是延迟送达）
    sched.schedule({ priority: 'visible', run: () => h.pause() })
    for (let n = 1; n <= 8; n++) {
      const step = n
      sched.schedule({
        priority: 'visible',
        run: () => {
          const next = data.value.slice()
          next.push(step)
          data.value = next
          triggerRef(data)
        },
      })
    }
    // 恢复作为分片内任务：resume 补一次最新值（一次 flush），随后同片继续写
    sched.schedule({
      priority: 'visible',
      run: async () => {
        h.resume()
        await nextTick()
      },
    })
    for (let n = 9; n <= WRITE_N; n++) {
      const step = n
      sched.schedule({
        priority: 'visible',
        run: () => {
          const next = data.value.slice()
          next.push(step)
          data.value = next
          triggerRef(data)
        },
      })
    }

    // 与调度器同口径的“帧/批次”刻度：rAF 或 64ms 兜底，统计每个刻度内 watcher flush 数
    const buckets: number[] = [0]
    let ticking = true
    let lastWatcherRuns = 0
    const pumpTicks = async (): Promise<void> => {
      while (ticking) {
        if (typeof document !== 'undefined' && document.hidden) {
          await new Promise((r) => setTimeout(r, 0))
        } else {
          await Promise.race([
            new Promise<void>((rq) => requestAnimationFrame(() => rq())),
            new Promise<void>((rs) => setTimeout(rs, 64)),
          ])
        }
        if (ticking) {
          buckets[buckets.length - 1] = buckets[buckets.length - 1]! + (watcherRuns - lastWatcherRuns)
          lastWatcherRuns = watcherRuns
          buckets.push(0)
        }
      }
    }
    void pumpTicks()

    await sched.whenIdle()
    ticking = false
    await nextTick()
    h()
    // 收尾竞态兜底：pump 可能在最后一个边界后才退出，把残余 watcher 增量归入最后一桶
    {
      const tail = watcherRuns - lastWatcherRuns
      if (tail > 0) buckets[buckets.length - 1] = buckets[buckets.length - 1]! + tail
    }

    const maxPerFrame = buckets.reduce((m, x) => Math.max(m, x ?? 0), 0)
    const noLossOk = applied.length === WRITE_N && applied.every((x, idx) => x === idx + 1)
    const recursionOk = syncReentries === 0 && watcherRuns <= WRITE_N + 1
    const flushBoundOk = maxPerFrame <= 2
    // resume 必补一次 + 至少一次片末合帧；具体次数随宿主帧时序，下界足以证明更新在流动
    const sawFlushOk = watcherRuns >= 2
    sched.dispose()
    push(
      '分片写shallowRef×pause/resume竞争',
      noLossOk && recursionOk && flushBoundOk && sawFlushOk,
      `更新不丢=${noLossOk}(len=${applied.length}) watcher=${watcherRuns} 同步重入=${syncReentries} 每帧flush峰值=${maxPerFrame}(≤2=${flushBoundOk})`,
    )
  }

  /* 9. 迁移竞态：入队即 cancel 再隐藏/恢复，任务从未执行且 done 正常 settle */
  {
    const ran: number[] = []
    const sched = createScheduler({ frameBudgetMs: 8 })
    sched.setHiddenForTest(false)

    const handles = [0, 1, 2, 3, 4].map((n) => {
      const hdl = sched.schedule({
        priority: n % 2 === 0 ? 'critical' : 'visible',
        run: () => { ran.push(n) },
      })
      hdl.cancel() // 入队后立刻取消
      return hdl
    })
    // 再经历完整隐藏 → 恢复迁移（取消标记随任务对象移动，永不执行）
    sched.setHiddenForTest(true)
    sched.setHiddenForTest(false)
    const settled = await Promise.all(
      handles.map((hdl) => hdl.done.then(() => 'resolved' as const)),
    )
    await sched.whenIdle()
    const neverRanOk = ran.length === 0 && sched.executed === 0
    const doneOk = settled.every((x) => x === 'resolved')
    const queueEmptyOk = sched.pending === 0
    sched.dispose()
    push(
      '迁移竞态:cancel×隐藏×恢复',
      neverRanOk && doneOk && queueEmptyOk,
      `从未执行=${neverRanOk} done全部resolve=${doneOk}(n=${settled.length}) 队列清空=${queueEmptyOk}`,
    )
  }

  /* 10. 场景c：batch+shallow+pause 全开，每帧 50 条流 + 16ms 定时器叠加，连续 10s */
  {
    const RUN_MS = 10000
    // 与 ScenarioC 优化路径同构：StreamBuffer(drop-oldest,240) + 边界合帧 + shallowRef+triggerRef
    const state = createOptimizedState()
    const buffer = createStreamBuffer<StreamMsg>(240, 'drop-oldest')
    const writer = createBatchedWriter(state, buffer)

    // 本地 flush 计数：仅在确实取到消息并批量写入时记一轮（与 writer 同口径，
    // 不走全局 obs，避免与页面其他渲染串扰）
    const origDrain = writer.drainFrame
    let flushes = 0
    writer.drainFrame = () => {
      if (buffer.size > 0) {
        flushes++
        origDrain()
      }
    }

    // 镜像账：独立记录进入管道的消息（不与 buffer 共享状态）
    const entered: StreamMsg[] = []
    const sources = createSources(
      (m) => {
        entered.push(m)
        writer.onMessage(m)
      },
      { timerIntervalMs: 16, streamBurst: true },
    )

    // pause 全开：统计 watcher 中途暂停 1s（源不停），恢复后必须补一次最新值
    const summary = ref(0)
    const statsSeen: number[] = []
    const statsHandle = watch(summary, (v) => statsSeen.push(v))

    let frames = 0
    let pumping = true
    let startAt = 0
    const pump = async (): Promise<void> => {
      startAt = performance.now()
      while (pumping) {
        await frameBoundary()
        frames++
        writer.drainFrame()
        const list = state.list.value
        let sum = 0
        for (const m of list) sum += m.payload
        summary.value = list.length * 1000003 + (sum % 100003)
      }
    }

    sources.start()
    void pump()

    await new Promise((r) => setTimeout(r, 1000))
    statsHandle.pause()
    const pausedAt = statsSeen.length
    await new Promise((r) => setTimeout(r, 1000))
    statsHandle.resume()
    await nextTick()
    const pauseResumeOk = statsSeen.length === pausedAt + 1

    await new Promise((r) => setTimeout(r, RUN_MS - 2000))
    sources.stop()
    // 停止后给已在 MessageChannel 途中的消息一点送达时间，再最终合帧
    await new Promise((r) => setTimeout(r, 50))
    pumping = false
    writer.drainFrame()
    await nextTick()
    const elapsed = performance.now() - startAt

    /* ---- 对账（全部基于实际运行计数，无硬编码期望）---- */
    // (1) seq 无重复（全局唯一）；到达顺序因 rAF/定时器/MessageChannel 三源交错
    //     不保证按 seq 单调，因此断言改为：无重复 + 同源内严格递增。
    let seqOk = entered.length > 0
    const seen = new Set<number>()
    for (const m of entered) {
      if (seen.has(m.seq)) seqOk = false
      seen.add(m.seq)
    }
    const lastBySource: Record<string, number> = { timer: -1, raf: -1, stream: -1 }
    for (const m of entered) {
      if (m.seq <= lastBySource[m.source]!) seqOk = false
      lastBySource[m.source] = m.seq
    }

    const finalList = state.list.value
    // drop-oldest 语义下，任何丢弃/窗口裁剪淘汰的都是当时最旧的消息，
    // 因此最终幸存者必须严格等于“全部已收到 seq 的最后 K 个”，
    // K = min(LIST_CAP, 收到数 - 缓冲丢弃数)（与 optimized.ts 同口径）。
    const accepted = entered.length - buffer.dropped
    const expectLen = Math.min(LIST_CAP, accepted)
    const expectedSeqs = entered.slice(entered.length - expectLen).map((m) => m.seq)
    const listMatchOk =
      finalList.length === expectedSeqs.length &&
      finalList.every((m, idx) => m.seq === expectedSeqs[idx])

    // 离开管道的消息要么计入 buffer.dropped，要么属于 LIST_CAP 窗口裁剪，无第三条去向
    const capOk = finalList.length <= LIST_CAP
    const dropExplainedOk =
      entered.length - finalList.length - buffer.dropped === Math.max(0, accepted - LIST_CAP)
    const bufferDrainedOk = buffer.size === 0

    // (4) flush 轮次 ≤ 帧数 × 1.2（合帧封顶帧率；64ms 兜底帧按同口径算）
    const flushBoundOk = flushes <= Math.ceil(frames * 1.2)
    const flushRatio = frames > 0 ? flushes / frames : 0
    const ratioDetail = frames > 0 ? flushRatio.toFixed(2) : 'n/a'

    statsHandle()
    push(
      '场景c 10s竞争(50/帧+16ms定时器)',
      seqOk && listMatchOk && capOk && dropExplainedOk && bufferDrainedOk && flushBoundOk && pauseResumeOk,
      `收到=${entered.length} 列表=${finalList.length} dropped=${buffer.dropped} seq连续=${seqOk} 最终集合对账=${listMatchOk} 丢弃可解释=${dropExplainedOk} 缓冲排空=${bufferDrainedOk} flush=${flushes} 帧=${frames} 比值=${ratioDetail}(≤1.2=${flushBoundOk}) pause恢复=${pauseResumeOk} 历时=${(elapsed / 1000).toFixed(1)}s`,
    )
  }

  return results
}
