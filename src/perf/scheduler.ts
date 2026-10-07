import { reactive } from 'vue'

/**
 * 手段 7（v2）：双队列自适应分片调度器。
 *
 * 两条队列：
 * - 帧预算队列 frameQueue：critical / visible，rAF 对齐 + 8ms 帧预算切片。
 * - 后台宏任务队列 macroQueue：idle（以及隐藏时迁移过来的帧任务），
 *   由 scheduler.yield() → MessageChannel → setTimeout(0) 降级链驱动。
 *
 * 可见性迁移（document.visibilitychange）：
 * - hidden：帧队列中所有待执行任务迁移到宏任务队列（rAF 在隐藏页签不触发）。
 * - visible：迁移过去的任务按原优先级迁回帧队列；原生 idle 永远留在宏任务队列。
 * - 迁移只改任务驻留队列，不改状态机：cancel/done 语义与 v1 完全一致。
 *
 * 慢任务降级：单任务执行 > slowTaskMs(3ms) 记 slow，同一批次内仍在排队的
 * 同源（task.source 相同）后继任务有效优先级降一级：
 * critical→visible（帧队列内重排），visible→idle（移入宏任务队列）。
 *
 * 可见时为保持 v1 的“帧任务先于 idle、同优先级 FIFO”总序，
 * 帧切片排空帧队列后若仍有预算，会顺带捎带宏任务队列中的 idle（park 捎带）；
 * hidden 时帧队列必然为空，全部任务走宏任务链。
 *
 * 取消 / 错误 / whenIdle / cancelAll / dispose / EMA 自适应片大小
 * 与 v1 对外 API 完全兼容（仅新增只读指标与 TaskHandle.getPriority）。
 */

export type TaskPriority = 'critical' | 'visible' | 'idle'

export interface SchedTask {
  id: number
  priority: TaskPriority
  run: () => void | Promise<void>
  /** 同源标记：慢任务降级只影响同 source 的批次后继；缺省不参与降级 */
  source?: string | number
}

export interface TaskHandle {
  id: number
  cancel: () => void
  done: Promise<void>
  /** 当前有效优先级（可能已被慢任务降级） */
  getPriority: () => TaskPriority
}

export interface SchedulerOptions {
  frameBudgetMs?: number
  maxChunk?: number
  /** 慢任务阈值，默认 3ms */
  slowTaskMs?: number
  onError?: (err: unknown, task: SchedTask) => void
  /** 测试用：不自行监听 document visibilitychange（迁移仍可由 setHidden 触发） */
  manualVisibility?: boolean
}

type TaskStatus = 'queued' | 'running' | 'settled'

interface QueuedTask extends SchedTask {
  cancelled: boolean
  basePriority: TaskPriority
  effPriority: TaskPriority
  status: TaskStatus
  /** 入队序号：同优先级 FIFO */
  seq: number
  /** 是否由可见性迁移到宏任务队列（visible 时迁回的依据） */
  migrated: boolean
  resolve: () => void
  reject: (err: unknown) => void
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

function isFramePriority(p: TaskPriority): boolean {
  return p === 'critical' || p === 'visible'
}

/** 慢任务降级一级：critical→visible，visible→idle，idle 保持 idle */
function demote(p: TaskPriority): TaskPriority {
  return p === 'critical' ? 'visible' : p === 'visible' ? 'idle' : 'idle'
}

/** 按有效优先级 + FIFO(seq) 插入队列 */
function insertOrdered(queue: QueuedTask[], task: QueuedTask): void {
  let idx = queue.length
  while (
    idx > 0 &&
    (PRIORITY_ORDER[queue[idx - 1]!.effPriority] > PRIORITY_ORDER[task.effPriority] ||
      (PRIORITY_ORDER[queue[idx - 1]!.effPriority] === PRIORITY_ORDER[task.effPriority] &&
        queue[idx - 1]!.seq > task.seq))
  ) {
    idx--
  }
  queue.splice(idx, 0, task)
}

function removeTask(queue: QueuedTask[], task: QueuedTask): boolean {
  const idx = queue.indexOf(task)
  if (idx >= 0) {
    queue.splice(idx, 1)
    return true
  }
  return false
}

/** 全局（跨实例）v2 指标，供面板展示；实例内另有独立计数 */
export const schedulerStats = reactive({
  slowTasks: 0,
  migrations: 0,
  demotions: 0,
})

export interface Scheduler {
  schedule: (task: Omit<SchedTask, 'id'>) => TaskHandle
  cancelAll: () => void
  whenIdle: () => Promise<void>
  dispose: () => void
  /** 测试用：显式设置可见性并触发与真实 visibilitychange 等价的迁移 */
  setHidden: (hidden: boolean) => void
  readonly pending: number
  readonly executed: number
  readonly errors: unknown[]
  readonly avgTaskMs: number
  readonly slowTasks: number
  readonly migrations: number
  readonly demotions: number
}

export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const frameBudgetMs = options.frameBudgetMs ?? 8
  const maxChunk = options.maxChunk ?? 64
  const slowTaskMs = options.slowTaskMs ?? 3
  const frameQueue: QueuedTask[] = []
  const macroQueue: QueuedTask[] = []
  const errors: unknown[] = []
  let nextId = 1
  let nextSeq = 1
  let executed = 0
  let slowCount = 0
  let migrationCount = 0
  let demotionCount = 0
  let pumping = false
  let disposed = false
  let hiddenNow = typeof document !== 'undefined' ? document.hidden : false
  let emaTaskMs = 0.1 // 初始假设：每任务 0.1ms
  let idleResolve: (() => void) | null = null
  /** 当前正在执行的批次（切片）中出现过慢任务的 source 集合 */
  let batchSlowSources: Set<string | number> = new Set()

  function adaptiveChunkSize(): number {
    // EMA 采样驱动：预算的 80% 留给任务，余量给浏览器
    const size = Math.floor((frameBudgetMs * 0.8) / Math.max(emaTaskMs, 0.01))
    return Math.max(1, Math.min(maxChunk, size))
  }

  function totalPending(): number {
    return frameQueue.length + macroQueue.length
  }

  function notifyIdleIfDrained(): void {
    if (totalPending() === 0 && idleResolve !== null) {
      const r = idleResolve
      idleResolve = null
      r()
    }
  }

  /* ---------- 可见性迁移 ---------- */

  function migrateToMacro(): void {
    if (frameQueue.length === 0) return
    const moving = frameQueue.splice(0, frameQueue.length)
    for (const t of moving) {
      t.migrated = true
      insertOrdered(macroQueue, t)
      migrationCount++
      schedulerStats.migrations++
    }
  }

  function migrateToFrame(): void {
    if (macroQueue.length === 0) return
    const staying: QueuedTask[] = []
    for (const t of macroQueue.splice(0, macroQueue.length)) {
      if (t.migrated && isFramePriority(t.effPriority)) {
        t.migrated = false
        insertOrdered(frameQueue, t)
        migrationCount++
        schedulerStats.migrations++
      } else {
        // 原生 idle，或迁移期间被慢降级为 idle 的任务，留在宏任务队列
        staying.push(t)
      }
    }
    for (const t of staying) macroQueue.push(t)
  }

  function setHidden(hidden: boolean): void {
    if (disposed || hidden === hiddenNow) return
    hiddenNow = hidden
    if (hidden) {
      migrateToMacro()
    } else {
      migrateToFrame()
    }
    void pump()
  }

  /* ---------- 慢任务批次降级 ---------- */

  /**
   * 同批次内同源后继降级：改 effPriority 并在两队列间搬运。
   * 仅影响仍排队（queued）的任务，不动 running/settled。
   */
  function demoteSameSource(source: string | number): void {
    // 快照遍历：降级会搬运任务（frameQueue→macroQueue），不能边遍历边跨队列改
    for (const t of [...frameQueue, ...macroQueue]) {
      if (t.source !== source || t.status !== 'queued') continue
      if (t.effPriority === 'idle') continue
      const from = isFramePriority(t.effPriority) ? frameQueue : macroQueue
      if (removeTask(from, t)) {
        t.effPriority = demote(t.effPriority)
        insertOrdered(isFramePriority(t.effPriority) ? frameQueue : macroQueue, t)
        demotionCount++
        schedulerStats.demotions++
      }
    }
  }

  /* ---------- 核心执行循环 ---------- */

  /**
   * 从给定队列取一个任务执行（不做队列选择，由调用方保证队列语义）。
   * 返回该任务墙钟耗时（ms）。
   */
  async function executeFrom(queue: QueuedTask[]): Promise<number> {
    const task = queue.shift()!
    task.status = 'running'
    const taskStart = performance.now()
    try {
      await task.run()
      task.status = 'settled'
      task.resolve()
    } catch (err) {
      task.status = 'settled'
      errors.push(err)
      options.onError?.(err, task)
      task.reject(err)
    }
    executed++
    const taskMs = performance.now() - taskStart
    // EMA 更新（alpha=0.3），钳制到合理区间
    emaTaskMs = Math.min(50, Math.max(0.01, 0.7 * emaTaskMs + 0.3 * taskMs))
    // 慢任务：本批次同源后继降一级
    if (taskMs > slowTaskMs && task.source !== undefined && !task.cancelled) {
      slowCount++
      schedulerStats.slowTasks++
      if (!batchSlowSources.has(task.source)) {
        batchSlowSources.add(task.source)
        demoteSameSource(task.source)
      }
    }
    return taskMs
  }

  /** 连续排空一个队列直到预算用尽/片满/队列空；返回是否耗尽预算 */
  async function drainQueue(queue: QueuedTask[], sliceStart: number, chunk: number): Promise<number> {
    let used = chunk
    while (used > 0 && queue.length > 0 && !disposed) {
      await executeFrom(queue)
      used--
      // await（可能跨微任务 flush / 宏任务让出）后重新检查帧预算
      if (performance.now() - sliceStart >= frameBudgetMs) break
    }
    return used
  }

  /**
   * 单轮 pump：
   * - hidden：全部在宏任务队列，按宏任务节奏消费。
   * - visible：先等帧边界（rAF），帧队列 8ms 切片；帧队列空且本帧有余量时
   *   park 捎带宏任务队列（保 v1 总序：帧任务永远先于 idle）。
   */
  async function pumpOnce(): Promise<void> {
    if (disposed) return
    if (hiddenNow) {
      await yieldToBrowser()
      if (disposed) return
      const sliceStart = performance.now()
      await drainQueue(macroQueue, sliceStart, adaptiveChunkSize())
      return
    }
    await frameBoundary()
    if (disposed) return
    batchSlowSources = new Set()
    const sliceStart = performance.now()
    let chunk = adaptiveChunkSize()
    const remain = await drainQueue(frameQueue, sliceStart, chunk)
    chunk = remain
    // 帧队列已空且本帧仍有预算：park 捎带 idle 宏任务（不新开宏任务往返）
    if (frameQueue.length === 0 && chunk > 0 && performance.now() - sliceStart < frameBudgetMs) {
      await drainQueue(macroQueue, sliceStart, chunk)
    }
    // 预算耗尽但仍有任务：显式让出一次，避免阻塞输入
    if (totalPending() > 0 && performance.now() - sliceStart >= frameBudgetMs) {
      await yieldToBrowser()
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (totalPending() > 0 && !disposed) {
        await pumpOnce()
      }
    } finally {
      pumping = false
      notifyIdleIfDrained()
    }
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
    const queued: QueuedTask = {
      ...task,
      id: nextId++,
      basePriority: task.priority,
      effPriority: task.priority,
      status: 'queued',
      seq: nextSeq++,
      migrated: false,
      cancelled: false,
      resolve: resolveFn,
      reject: rejectFn,
    }
    // hidden 时新入队的帧任务同样直接驻留宏任务链（rAF 不触发）
    const parkToMacro = hiddenNow && isFramePriority(queued.effPriority)
    if (parkToMacro) queued.migrated = true
    insertOrdered(parkToMacro ? macroQueue : isFramePriority(queued.effPriority) ? frameQueue : macroQueue, queued)
    void pump()
    return {
      id: queued.id,
      cancel: () => {
        // 已完成：幂等无操作；执行中：不可抢占（与 v1 一致），仅打标（其 done 已随执行 settle）
        if (queued.status !== 'queued') {
          queued.cancelled = true
          return
        }
        // 待执行：立刻移出所在队列并 settle done；迁移后同样成立（先定位再移除）
        queued.cancelled = true
        if (!removeTask(frameQueue, queued)) removeTask(macroQueue, queued)
        queued.status = 'settled'
        queued.resolve()
        notifyIdleIfDrained()
      },
      done,
      getPriority: () => queued.effPriority,
    }
  }

  /* 真实 document 可见性：与 setHidden 共用迁移逻辑 */
  function onVisibilityChange(): void {
    setHidden(document.hidden)
  }
  if (!options.manualVisibility && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  return {
    schedule,
    cancelAll: () => {
      for (const t of frameQueue.splice(0)) {
        t.cancelled = true
        t.status = 'settled'
        t.resolve()
      }
      for (const t of macroQueue.splice(0)) {
        t.cancelled = true
        t.status = 'settled'
        t.resolve()
      }
      notifyIdleIfDrained()
    },
    whenIdle: () => {
      if (totalPending() === 0) return Promise.resolve()
      return new Promise((resolve) => {
        idleResolve = resolve
      })
    },
    dispose: () => {
      disposed = true
      if (!options.manualVisibility && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      // 在队列中未执行的任务按取消 settle（done resolve），避免悬挂
      for (const t of frameQueue.splice(0)) {
        t.cancelled = true
        t.status = 'settled'
        t.resolve()
      }
      for (const t of macroQueue.splice(0)) {
        t.cancelled = true
        t.status = 'settled'
        t.resolve()
      }
      notifyIdleIfDrained()
    },
    setHidden,
    get pending() {
      return totalPending()
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
    get slowTasks() {
      return slowCount
    },
    get migrations() {
      return migrationCount
    },
    get demotions() {
      return demotionCount
    },
  }
}
