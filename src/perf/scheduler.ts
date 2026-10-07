/**
 * 手段 7（v2）：双队列自适应分片调度器。
 *
 * 队列划分：
 * - 帧预算队列（critical/visible）：rAF 对齐 + 每片 8ms 帧预算，优先消费。
 * - 后台宏任务队列（idle）：scheduler.yield() → MessageChannel → setTimeout(0)
 *   降级链驱动；可见时与帧边界对齐，隐藏时宏任务持续 drain，不阻塞输入。
 *
 * 可见性迁移：
 * - document 隐藏：帧队列中待执行任务整体迁移到宏任务链（rAF 在隐藏页签不触发）。
 * - 恢复可见：宏队列中的帧级任务整体迁回帧队列。
 * - 迁移只移动持有权，不动任务状态：已取消任务迁移后仍不执行且 done 仍 resolve；
 *   正在执行的任务跑完当前 run 后才参与后续迁移；已完成的任务不在队列中，不受影响。
 *
 * 慢任务降级：
 * - 单个任务耗时 > 3ms 记一次 slow；同一批次（同一次切片）内其后继的同源
 *   （同原始优先级）待执行任务有效优先级降一级（critical→visible→idle），
 *   仅影响本片后续挑选顺序，下一片恢复原始优先级。跨队列不迁移（见 notes）。
 *
 * 兼容性：保留 v1 全部导出（schedule/cancelAll/whenIdle/dispose、pending、
 * executed、errors、avgTaskMs、yieldStrategy、yieldToBrowser、frameBoundary）。
 */

import { reactive } from 'vue'

export type TaskPriority = 'critical' | 'visible' | 'idle'

export interface SchedTask {
  id: number
  priority: TaskPriority
  run: () => void | Promise<void>
}

export interface TaskHandle {
  id: number
  cancel: () => void
  done: Promise<void>
}

export interface SchedulerOptions {
  frameBudgetMs?: number
  maxChunk?: number
  /** 慢任务阈值：任务执行超过该毫秒数记 slow 并对同片后继同源任务降级。默认 3ms */
  slowThresholdMs?: number
  onError?: (err: unknown, task: SchedTask) => void
}

/* ---------- 让出链：scheduler.yield → MessageChannel → setTimeout ---------- */

interface SchedulerWithYield {
  yield?: () => Promise<void>
}

const hasSchedulerYield =
  typeof (globalThis as { scheduler?: SchedulerWithYield }).scheduler?.yield === 'function'

export const yieldStrategy: 'scheduler.yield' | 'messagechannel' | 'settimeout' =
  hasSchedulerYield
    ? 'scheduler.yield'
    : typeof MessageChannel !== 'undefined'
      ? 'messagechannel'
      : 'settimeout'

let messageChannel: MessageChannel | null = null

export function yieldToBrowser(): Promise<void> {
  if (hasSchedulerYield) {
    return (globalThis as { scheduler: { yield: () => Promise<void> } }).scheduler.yield()
  }
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      if (messageChannel === null) messageChannel = new MessageChannel()
      messageChannel.port1.onmessage = () => resolve()
      messageChannel.port2.postMessage(null)
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

/**
 * 帧边界：可见时对齐 rAF；隐藏/被节流（rAF 不触发）时降级宏任务让出。
 * 兜底：rAF 超过 64ms 未回调（极端节流环境）也继续前进，保证任务必然完成。
 */
export function frameBoundary(): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden) return yieldToBrowser()
  return Promise.race([
    nextFrame(),
    new Promise<void>((resolve) => setTimeout(resolve, 64)),
  ])
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { critical: 0, visible: 1, idle: 2 }
const DEMOTED: Record<TaskPriority, TaskPriority> = {
  critical: 'visible',
  visible: 'idle',
  idle: 'idle',
}

export const schedStats = reactive({
  /** 全部调度器实例累计的慢任务次数（接入面板） */
  slowTasks: 0,
  /** 全部实例累计的跨队列迁移任务人次 */
  migrations: 0,
})

interface QueuedTask {
  id: number
  priority: TaskPriority
  run: () => void | Promise<void>
  cancelled: boolean
  resolve: () => void
  reject: (err: unknown) => void
}

export interface Scheduler {
  schedule: (task: Omit<SchedTask, 'id'>) => TaskHandle
  cancelAll: () => void
  whenIdle: () => Promise<void>
  dispose: () => void
  /** 仅供测试：强制可见性（undefined = 跟随 document.hidden） */
  setHiddenForTest: (hidden: boolean | undefined) => void
  readonly pending: number
  readonly framePending: number
  readonly macroPending: number
  readonly slowTasks: number
  readonly migrations: number
  readonly executed: number
  readonly errors: unknown[]
  readonly avgTaskMs: number
}

export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const frameBudgetMs = options.frameBudgetMs ?? 8
  const maxChunk = options.maxChunk ?? 64
  const slowThresholdMs = options.slowThresholdMs ?? 3
  const frameQ: QueuedTask[] = []
  const macroQ: QueuedTask[] = []
  const errors: unknown[] = []
  let nextId = 1
  let executed = 0
  let slowTasks = 0
  let migrations = 0
  let frameRunning = false
  let macroRunning = false
  let disposed = false
  /** 当前正在执行的帧批次数：进行中时宏队列必须等待，保证降级任务的 FIFO 语义 */
  let activeFrameSlices = 0
  /** 帧批次结束时唤醒等待中的宏循环 */
  let frameFreeWaiters: Array<() => void> = []

  function waitFrameFree(): Promise<void> {
    if (activeFrameSlices === 0) return Promise.resolve()
    return new Promise((resolve) => frameFreeWaiters.push(resolve))
  }
  let testHidden: boolean | null = null
  let hidden = isHidden()
  let emaTaskMs = 0.1 // 初始假设：每任务 0.1ms
  let idleResolvers: Array<() => void> = []

  function isHidden(): boolean {
    return testHidden ?? (typeof document !== 'undefined' ? document.hidden : false)
  }

  function adaptiveChunkSize(): number {
    // EMA 采样驱动：预算的 80% 留给任务，余量给浏览器
    const size = Math.floor((frameBudgetMs * 0.8) / Math.max(emaTaskMs, 0.01))
    return Math.max(1, Math.min(maxChunk, size))
  }

  function notifyIdleIfDrained(): void {
    if (frameQ.length === 0 && macroQ.length === 0 && idleResolvers.length > 0) {
      const rs = idleResolvers
      idleResolvers = []
      for (const r of rs) r()
    }
  }

  /**
   * 在单个批次（切片）内挑选下一个任务：
   * 原始优先级 + 慢任务后继同源降级 + 同级 FIFO（id 序）。
   */
  function pickIndex(q: QueuedTask[], demoted: boolean): number {
    let best = -1
    let bestRank = 99
    let bestId = Number.POSITIVE_INFINITY
    for (let i = 0; i < q.length; i++) {
      const t = q[i]!
      const eff = demoted ? DEMOTED[t.priority] : t.priority
      const rank = PRIORITY_ORDER[eff]
      if (rank < bestRank || (rank === bestRank && t.id < bestId)) {
        best = i
        bestRank = rank
        bestId = t.id
      }
    }
    return best
  }

  async function drainSlice(q: QueuedTask[]): Promise<void> {
    const sliceStart = performance.now()
    let chunk = adaptiveChunkSize()
    // 本批次内是否已出现慢任务：出现后其后继同源任务优先级降一级
    let demoted = false
    while (q.length > 0 && chunk > 0 && !disposed) {
      // 帧队列按（降级后的）优先级挑选；宏队列是后台队列，严格 FIFO：
      // 被慢任务降级过来的后继追加在队尾，必然排在同批原有 idle 之后。
      const idx = q === macroQ ? 0 : pickIndex(q, demoted)
      const task = q.splice(idx, 1)[0]!
      if (task.cancelled) {
        task.resolve()
        continue
      }
      const taskStart = performance.now()
      try {
        const ret = task.run()
        // 同步任务直接连续执行：不插 await 微任务，同片内多次 shallowRef
        // 写入只在切片结束后产生一轮 Vue pre-flush（每帧 flush 次数有上界）。
        if (ret !== undefined && ret !== null && typeof (ret as Promise<void>).then === 'function') {
          await ret
        }
        task.resolve()
      } catch (err) {
        errors.push(err)
        options.onError?.(err, task)
        task.reject(err)
      }
      executed++
      chunk--
      const taskMs = performance.now() - taskStart
      // EMA 更新（alpha=0.3），钳制到合理区间
      emaTaskMs = Math.min(50, Math.max(0.01, 0.7 * emaTaskMs + 0.3 * taskMs))
      if (taskMs > slowThresholdMs) {
        slowTasks++
        schedStats.slowTasks++
        demoted = true
        // 降一级即改类：visible→idle 的后继任务移交后台宏任务队列（FIFO 接在
        // 已有 idle 之后）；critical→visible 仍属帧级，留在本片按降级序挑选。
        // 仅影响同一批次内的待执行后继，下一批次入队的新任务不受影响。
        if (q === frameQ) {
          const moved: QueuedTask[] = []
          for (let i = q.length - 1; i >= 0; i--) {
            if (q[i]!.priority === 'visible') {
              moved.unshift(q.splice(i, 1)[0]!)
            }
          }
          if (moved.length > 0) {
            macroQ.push(...moved)
            void macroLoop()
          }
        }
      }
      // await 之后（可能跨了微任务 flush / 宏任务让出）重新检查预算
      if (performance.now() - sliceStart >= frameBudgetMs) break
    }
  }

  /**
   * 调度器内部边界：可见时对齐 rAF（64ms 超时兜底），隐藏时走宏任务让出链。
   * 与导出的 frameBoundary() 同口径，但可见性可被 setHiddenForTest 接管。
   */
  function boundary(): Promise<void> {
    if (hidden) return yieldToBrowser()
    return Promise.race([
      nextFrame(),
      new Promise<void>((resolve) => setTimeout(resolve, 64)),
    ])
  }

  async function frameLoop(): Promise<void> {
    if (frameRunning) return
    frameRunning = true
    try {
      // rAF 仅用于对齐首个批次；之后按帧预算决定让出（与 v1 同口径，吞吐不变）：
      // 预算未满 → 立即下一片；预算耗尽 → yield 让浏览器，再等下一对齐点。
      await boundary()
      while (!disposed && frameQ.length > 0) {
        if (hidden) {
          migrateQueues(true) // 隐藏：帧级任务移交宏任务链
          break
        }
        const sliceStart = performance.now()
        activeFrameSlices++
        try {
          await drainSlice(frameQ)
        } finally {
          activeFrameSlices--
          if (activeFrameSlices === 0) {
            const waiters = frameFreeWaiters
            frameFreeWaiters = []
            for (const w of waiters) w()
          }
        }
        if (frameQ.length === 0) break
        if (performance.now() - sliceStart < frameBudgetMs) continue // 预算未满：连续切片
        await yieldToBrowser() // 预算耗尽：让出主线程
        await boundary() // 再对齐下一帧/宏任务边界
      }
    } finally {
      frameRunning = false
      // 退出前若已隐藏（无 visibilitychange 事件的竞态），把残留帧级任务迁走
      if (!disposed && hidden && frameQ.length > 0) migrateQueues(true)
      notifyIdleIfDrained()
    }
  }

  async function macroLoop(): Promise<void> {
    if (macroRunning) return
    macroRunning = true
    try {
      while (!disposed && (macroQ.length > 0 || frameQ.length > 0)) {
        // 后台队列：每批次都经宏任务让出链进入，保证同步连续入队先沉淀，不阻塞输入
        await yieldToBrowser()
        if (disposed) break
        if (hidden) {
          if (frameQ.length > 0) migrateQueues(true)
          if (macroQ.length > 0) {
            await drainSlice(macroQ)
            if (macroQ.length > 0) await yieldToBrowser()
          }
          continue
        }
        // 可见：帧队列严格优先，等它排空（让出主线程，不忙等）
        if (frameQ.length > 0) {
          await boundary()
          continue
        }
        if (activeFrameSlices > 0) {
          await waitFrameFree()
          continue
        }
        if (macroQ.length > 0) {
          const sliceStart = performance.now()
          await drainSlice(macroQ)
          // 可见时 idle 不连续猛跑：每个批次后让出一次，把帧时间留给帧队列
          if (macroQ.length > 0 && performance.now() - sliceStart < frameBudgetMs) {
            await yieldToBrowser()
          }
        }
      }
    } finally {
      macroRunning = false
      notifyIdleIfDrained()
    }
  }

  /**
   * 可见性迁移：toHidden=true 帧→宏，false 宏→帧。
   * 只移动任务持有权，保留 FIFO 与全部任务状态；正在执行的任务已不在队列中。
   */
  function migrateQueues(toHidden: boolean): void {
    // 隐藏：帧队列整体 → 宏队列（idle 本就在宏队列）。
    // 恢复：只有帧级任务（critical/visible）迁回；idle 永远留在后台宏队列。
    const moving = (t: QueuedTask): boolean => toHidden || t.priority !== 'idle'
    const from = toHidden ? frameQ : macroQ
    const to = toHidden ? macroQ : frameQ
    if (from.length === 0) return
    const stay: QueuedTask[] = []
    let n = 0
    for (const t of from) {
      if (moving(t)) {
        to.push(t)
        n++
      } else {
        stay.push(t)
      }
    }
    if (toHidden) from.length = 0
    else from.splice(0, from.length, ...stay)
    migrations += n
    schedStats.migrations += n
    kick(to === frameQ)
  }

  function kick(preferFrame: boolean): void {
    if (disposed) return
    if (preferFrame) void frameLoop()
    void macroLoop()
  }

  function onVisibility(): void {
    const nowHidden = isHidden()
    if (nowHidden === hidden) return
    hidden = nowHidden
    migrateQueues(nowHidden)
  }

  function schedule(task: Omit<SchedTask, 'id'>): TaskHandle {
    let resolveFn!: () => void
    let rejectFn!: (err: unknown) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    // 防止未处理的 rejection 噪音：错误已经过 onError 上报
    done.catch(() => {})
    // idle → 后台宏任务队列；critical/visible → 帧预算队列（隐藏时同样进宏链）
    const useFrameQ = task.priority !== 'idle' && !isHidden()
    const queued: QueuedTask = {
      id: nextId++,
      priority: task.priority,
      run: task.run,
      cancelled: false,
      resolve: resolveFn,
      reject: rejectFn,
    }
    ;(useFrameQ ? frameQ : macroQ).push(queued)
    // 宏循环即便正在执行一个 idle 批次，该批次也受 8ms 预算上界约束，
    // 新帧级任务最迟在下一让出点由帧循环抢占，无需额外抢占机制。
    kick(useFrameQ)
    return {
      id: queued.id,
      cancel: () => {
        queued.cancelled = true
      },
      done,
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }

  return {
    schedule,
    cancelAll: () => {
      for (const t of frameQ.splice(0)) {
        t.cancelled = true
        t.resolve()
      }
      for (const t of macroQ.splice(0)) {
        t.cancelled = true
        t.resolve()
      }
      notifyIdleIfDrained()
    },
    whenIdle: () => {
      if (frameQ.length === 0 && macroQ.length === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        idleResolvers.push(resolve)
      })
    },
    dispose: () => {
      disposed = true
      frameQ.length = 0
      macroQ.length = 0
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      notifyIdleIfDrained()
    },
    setHiddenForTest: (h: boolean | undefined) => {
      testHidden = h === undefined ? null : h
      onVisibility()
    },
    get pending() {
      return frameQ.length + macroQ.length
    },
    get framePending() {
      return frameQ.length
    },
    get macroPending() {
      return macroQ.length
    },
    get slowTasks() {
      return slowTasks
    },
    get migrations() {
      return migrations
    },
    get executed() {
      return executed
    },
    get errors() {
      return errors
    },
    get avgTaskMs() {
      return emaTaskMs
    },
  }
}
