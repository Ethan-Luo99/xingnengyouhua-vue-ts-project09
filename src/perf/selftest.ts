import { ref, shallowRef, triggerRef, watch, watchEffect, nextTick } from 'vue'
import { memoize } from './lru'
import { createScheduler, type TaskHandle, type TaskPriority } from './scheduler'
import { createStreamBuffer } from './stream'
import { createSources, type StreamMsg } from '../scenarios/c/sources'
import { createOptimizedState, createBatchedWriter, LIST_CAP } from '../scenarios/c/optimized'

/**
 * 边界用例行为断言：全部基于真实响应式/调度/流行为，不允许硬编码结果。
 * 每个用例返回 { name, pass, detail }。
 * v2 起共 9 组：前 5 组为 v1 边界，后 4 组为双队列调度器 + 竞争边界。
 */

export interface SelfTestResult {
  name: string
  pass: boolean
  detail: string
}

/** 真实改变 document.hidden（只读属性，需 defineProperty）并派发 visibilitychange */
function setDocumentHidden(hidden: boolean): void {
  try {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    })
  } catch {
    /* 某些环境不可写时忽略，调度器仍可经 setHidden 驱动 */
  }
  document.dispatchEvent(new Event('visibilitychange'))
}

export async function runSelfTests(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const push = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail })
  }

  const FRAME_SAMPLES = 10 // 竞争用例每帧 flush 统计窗口（rAF 帧）

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

  /* 4. 双队列调度器 v2：完成性、优先级、取消、错误传播、重入 flush */
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
    const priorityOk = order[0] === -1 // critical 走帧队列先于宏任务 idle

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
    sched.dispose()
    s2.dispose()
    push(
      '双队列调度器边界',
      completeOk && cancelOk && errorOk && priorityOk && reentrantOk,
      `完成=${completeOk} 取消=${cancelOk} 错误传播=${errorOk} 帧先于宏=${priorityOk} 重入flush=${reentrantOk}`,
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

  /* 6. 竞争：分片任务内 triggerRef(shallowRef) 与 pause/resume watcher 同时发生 */
  {
    // 被写的 shallowRef（就地改 + triggerRef 的合帧模式）
    const state = shallowRef<number[]>([])
    // pause/resume 的目标源 + watcher（模拟场景C 离屏分支）
    const gate = ref(0)
    const gateSeen: number[] = []
    const gateWatch = watch(gate, (v) => gateSeen.push(v))

    // 按真实 rAF 帧统计 flush 次数：每帧（含其后微任务队列）最多允许 2 轮
    const flushPerFrame: number[] = []
    let currentFrameFlushes = 0
    // 默认 pre watcher：同一 flush 周期内多次 triggerRef 只回调一次（计 flush 轮次，非触发次数）
    const stopListWatch = watch(state, () => {
      currentFrameFlushes++
    })
    const flushBarrier = new Promise<void>((resolve) => {
      let frames = 0
      const tick = (): void => {
        flushPerFrame.push(currentFrameFlushes)
        currentFrameFlushes = 0
        frames++
        if (frames < FRAME_SAMPLES) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })

    // 递归超限探针：劫持 console.error 捕获 Vue 的 Maximum recursive updates
    const recursiveErrors: string[] = []
    const origError = console.error
    const patchedError = (...args: unknown[]): void => {
      const text = args.map(String).join(' ')
      if (text.includes('Maximum recursive updates')) recursiveErrors.push(text)
      origError.apply(console, args as [unknown?, ...unknown[]])
    }
    console.error = patchedError as typeof console.error

    const FRAMES_WRITES = 12
    const sched = createScheduler({ frameBudgetMs: 8 })
    // 单个分片任务：同步连续就地写 + triggerRef 多次（同帧应被 Vue 合并）
    sched.schedule({
      priority: 'critical',
      run: async () => {
        const arr = state.value
        for (let i = 0; i < FRAMES_WRITES; i++) {
          arr.push(i)
          triggerRef(state) // 多次触发：同一 flush 周期内去重
        }
        await nextTick()
      },
    })
    // 与任务并发：连续 pause→写 gate→resume，制造 watcher 与 triggerRef 的竞争
    for (let i = 0; i < 4; i++) {
      gateWatch.pause()
      gate.value = 100 + i // 暂停期写入：不得触发
      await nextTick()
      gateWatch.resume() // resume 补最新值一次
      gate.value = 200 + i // 恢复后写入不得丢
      await nextTick()
    }
    await sched.whenIdle()
    sched.dispose()
    await flushBarrier
    console.error = origError
    stopListWatch()
    gateWatch()

    // 断言 1：更新不丢 —— shallowRef 列表 12 条全到；
    // gate：暂停期(100+i)写入被 pause 吞掉（正确行为），每次 resume 补一次当时最新值，
    // resume 之后的(200+i)写入全部到达且不丢（pause 结束在 200+i 写入之前，故只看到 200..203）
    const listOk = state.value.length === FRAMES_WRITES
    const pausedSwallowed = !gateSeen.some((v) => v >= 100 && v < 200)
    const expectedGate = [200, 201, 202, 203]
    const gateOk =
      pausedSwallowed &&
      gateSeen.length === expectedGate.length &&
      expectedGate.every((v, i) => gateSeen[i] === v)
    // 断言 2：无递归超限
    const noRecursionOk = recursiveErrors.length === 0
    // 断言 3：每帧 flush ≤ 2（合帧生效，未退化为每写一轮）
    const maxFlushPerFrame = flushPerFrame.reduce((a, b) => Math.max(a, b), 0)
    const flushFrameOk = maxFlushPerFrame <= 2
    push(
      'triggerRef × pause/resume 竞争',
      listOk && gateOk && noRecursionOk && flushFrameOk,
      `更新不丢(列表=${listOk},watcher=${gateOk}) 无递归超限=${noRecursionOk} 每帧flush峰值=${maxFlushPerFrame}(≤2=${flushFrameOk}) gateSeen=[${gateSeen.join(',')}]`,
    )
  }

  /* 7. 竞争：入队即 cancel 后再隐藏/恢复迁移——任务从不执行，done 正常 settle */
  {
    setDocumentHidden(false)
    const sched = createScheduler({ frameBudgetMs: 8 })

    let canceledRan = false
    let canceledSettled = false
    // 帧队列任务：入队后立刻 cancel（此时尚未到下一个 rAF，必仍在队列中）
    const h1 = sched.schedule({
      priority: 'critical',
      run: () => {
        canceledRan = true
      },
    })
    h1.cancel()
    h1.done.then(() => {
      canceledSettled = true
    })

    // 对照组：未取消的帧任务在隐藏后必须经宏任务链执行（证明迁移链路真实存在）
    let survivorRan = false
    sched.schedule({
      priority: 'visible',
      run: () => {
        survivorRan = true
      },
    })

    // 立刻隐藏：已取消任务已不在任何队列；幸存者帧→宏任务迁移
    setDocumentHidden(true)
    // 再来回切换，制造“迁移中 cancel”竞争窗口
    let canceledRanLate = false
    const h3 = sched.schedule({
      priority: 'visible',
      run: () => {
        canceledRanLate = true
      },
    })
    h3.cancel()
    let h3Settled = false
    h3.done.then(() => {
      h3Settled = true
    })
    setDocumentHidden(false)
    setDocumentHidden(true)

    await sched.whenIdle()
    const migrations = sched.migrations
    sched.dispose()
    setDocumentHidden(false)
    // settle 回调是微任务：再让一拍确保观测
    await Promise.resolve()

    const cancelOk = !canceledRan && !canceledRanLate
    const settleOk = canceledSettled && h3Settled
    const migrationOk = migrations >= 2 && survivorRan
    push(
      '迁移 × 取消竞争',
      cancelOk && settleOk && migrationOk,
      `已取消从不执行=${cancelOk} done均settle=${settleOk} 迁移实际发生(迁移次数=${migrations},幸存执行=${survivorRan})=${migrationOk}`,
    )
  }

  /* 8. 慢任务降级：>3ms 任务记 slow，同批次同源后继降一级（跨队列可观测） */
  {
    setDocumentHidden(false)
    // 预算 4ms / 慢阈值 3ms：慢任务(4ms) 当帧耗尽预算，被降级后继必落到下一帧的宏任务链
    const sched = createScheduler({ frameBudgetMs: 4, slowTaskMs: 3 })
    const trace: string[] = []
    const priorityAtRun: Record<string, string> = {}
    const mark = (tag: string, handle: () => TaskPriority): (() => void) => () => {
      priorityAtRun[tag] = handle()
      trace.push(tag)
    }

    let hf1!: TaskHandle
    let hf2!: TaskHandle
    // 异源 critical：帧序最前，不受 S 降级影响
    const hc = sched.schedule({ priority: 'critical', source: 'OTHER', run: mark('criticalX', () => hc.getPriority()) })
    // 慢任务(visible, S)：>3ms 记 slow、>4ms 预算当帧让出
    sched.schedule({ priority: 'visible', source: 'S', run: () => busyWait(5) })
    // 同批次同源 visible 后继：被降为 idle（进入宏任务链，下一帧才执行）
    hf1 = sched.schedule({ priority: 'visible', source: 'S', run: mark('fast1', () => hf1.getPriority()) })
    // 下一帧才入队的新任务：不属于慢任务所在批次，必须保持 visible 不被降级
    setTimeout(() => {
      hf2 = sched.schedule({ priority: 'visible', source: 'S', run: mark('fast2', () => hf2.getPriority()) })
    }, 30)

    await sched.whenIdle()
    // fast2 由 30ms 定时器排入；再给一拍确保其执行完
    await new Promise((r) => setTimeout(r, 50))

    const slowOk = sched.slowTasks >= 1
    const demotionsOk = sched.demotions === 1 // 仅同批次 fast1 被降，不波及下帧新任务
    const demotedHandleOk = hf1.getPriority() === 'idle'
    const otherUnaffectedOk = hc.getPriority() === 'critical' && hf2.getPriority() === 'visible'
    const fast1IdleAtRun = priorityAtRun['fast1'] === 'idle'
    const fast2VisibleAtRun = priorityAtRun['fast2'] === 'visible'
    const criticalAtRun = priorityAtRun['criticalX'] === 'critical'
    // 被降级 fast1 走第二帧宏任务链，晚于第一帧 criticalX
    const orderOk = trace.indexOf('criticalX') === 0 && trace.indexOf('fast1') > 0
    sched.dispose()
    push(
      '慢任务同源批次降级',
      slowOk && demotionsOk && demotedHandleOk && fast1IdleAtRun && otherUnaffectedOk && fast2VisibleAtRun && criticalAtRun && orderOk,
      `slow=${sched.slowTasks} 降级数=${sched.demotions}(=1) 同批后继fast1→${hf1.getPriority()}(执行时${priorityAtRun['fast1']}) 下帧fast2保持=${hf2.getPriority()}(执行时${priorityAtRun['fast2']}) 异源=${hc.getPriority()} 序=[${trace.join('→')}]`,
    )
  }

  /* 9. 场景C 全开对账：batch+shallow+pause，50条/帧流 + 16ms 定时器，连续 10s */
  {
    setDocumentHidden(false)
    const CAP = 240
    const buffer = createStreamBuffer<StreamMsg>(CAP, 'drop-oldest')
    const state = createOptimizedState()
    const writer = createBatchedWriter(state, buffer)
    // 对账管线：同容量/策略/消费节奏的独立参照，喂同一条消息、同节奏 drain
    const refBuffer = createStreamBuffer<StreamMsg>(CAP, 'drop-oldest')
    const refList: StreamMsg[] = []

    let flushRounds = 0
    let frames = 0
    let rafLive = true
    const frameCounter = new Promise<void>((resolve) => {
      const tick = (): void => {
        if (!rafLive) return resolve()
        frames++
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    const summary = ref(0)
    let watchRuns = 0
    const statWatch = watch(summary, () => watchRuns++, { flush: 'pre' })

    let produced = 0
    const sources = createSources(
      (m: StreamMsg) => {
        buffer.push(m)
        refBuffer.push(m)
        state.received++
      },
      { extraIntervalMs: 16, onEmit: () => { produced++ } },
    )

    let draining = true
    function nextFrame(): Promise<void> {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()))
    }
    const drain = async (): Promise<void> => {
      while (draining) {
        await nextFrame()
        if (buffer.size > 0) {
          writer.drainFrame()
          flushRounds++
          refList.push(...refBuffer.drain())
          if (refList.length > LIST_CAP) refList.splice(0, refList.length - LIST_CAP)
          const list = state.list.value
          let sum = 0
          for (const x of list) sum += x.payload
          summary.value = list.length * 1000003 + (sum % 100003)
        }
      }
    }

    sources.start()
    void drain()
    for (const at of [800, 800 + 1800, 800 + 1800 * 2, 800 + 1800 * 3]) {
      setTimeout(() => {
        statWatch.pause()
        setTimeout(() => statWatch.resume(), 300)
      }, at)
    }

    await new Promise((r) => setTimeout(r, 10000))
    sources.stop()
    draining = false
    rafLive = false
    await frameCounter
    if (buffer.size > 0) {
      writer.drainFrame()
      flushRounds++
      refList.push(...refBuffer.drain())
      if (refList.length > LIST_CAP) refList.splice(0, refList.length - LIST_CAP)
    }
    statWatch()

    const droppedMatch = refBuffer.dropped === buffer.dropped
    const finalList = state.list.value
    const sameLength = finalList.length === refList.length
    const sameSeqs = sameLength && finalList.every((m, i) => m.seq === refList[i]!.seq)
    const receivedMatch = buffer.received === produced && refBuffer.received === produced
    const windowTrimmed = Math.max(0, produced - buffer.dropped - LIST_CAP)
    const dropExplained = produced - finalList.length === buffer.dropped + windowTrimmed
    const seqMonotonic = finalList.every((m, i) => i === 0 || m.seq > finalList[i - 1]!.seq)
    const flushOk = flushRounds <= frames * 1.2
    push(
      '场景C 10s 全开对账',
      droppedMatch && sameSeqs && receivedMatch && dropExplained && seqMonotonic && flushOk && watchRuns > 0,
      `10s: 帧=${frames} flush=${flushRounds}(预算${(frames * 1.2).toFixed(0)}) 产出=${produced} 双管线dropped=${buffer.dropped}/${refBuffer.dropped} 终态一致=${sameSeqs} 丢弃+窗口可解释=${dropExplained} seq单调=${seqMonotonic} watcher=${watchRuns}次`,
    )
  }

  return results
}

/* 纯 CPU 忙等（不依赖 scheduler 的性能计时），用于稳定制造 >3ms 慢任务 */
function busyWait(ms: number): void {
  const end = performance.now() + ms
  let acc = 0
  while (performance.now() < end) {
    acc = (acc * 31 + 1) % 1000003
  }
  void acc
}
