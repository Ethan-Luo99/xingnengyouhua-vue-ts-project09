/**
 * 手段 7：rAF + MessageChannel 自适应分片调度器。
 *
 * - 8ms 帧预算：每个 rAF 切片内任务总耗时不超过 frameBudgetMs。
 * - 动态分片粒度：对任务耗时做 EMA 采样，自适应每片任务数（带上下限钳制）。
 * - 让出链：scheduler.yield()（特性检测）→ MessageChannel → setTimeout(0)。
 *   rAF 在隐藏页签下不触发，隐藏时自动降级为宏任务驱动。
 * - 取消：schedule 返回句柄，cancel 后任务被跳过；cancelAll 清空队列。
 * - 错误传播：任务抛错不中断队列，经 onError 上报，任务级 promise reject。
 * - 重入 flush 边界：任务内写响应式状态会排入 Vue 微任务 flush；
 *   任务可 await nextTick() 等待 flush 完成。await 后重新检查帧预算，
 *   超预算即让出，保证切片不超时、不递归重入调度器本体。
 */

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
  onError?: (err: unknown, task: SchedTask) => void
}

interface QueuedTask extends SchedTask {
  cancelled: boolean
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

export interface Scheduler {
  schedule: (task: Omit<SchedTask, 'id'>) => TaskHandle
  cancelAll: () => void
  whenIdle: () => Promise<void>
  dispose: () => void
  readonly pending: number
  readonly executed: number
  readonly errors: unknown[]
  readonly avgTaskMs: number
}

export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const frameBudgetMs = options.frameBudgetMs ?? 8
  const maxChunk = options.maxChunk ?? 64
  const queue: QueuedTask[] = []
  const errors: unknown[] = []
  let nextId = 1
  let executed = 0
  let running = false
  let disposed = false
  let emaTaskMs = 0.1 // 初始假设：每任务 0.1ms
  let idleResolve: (() => void) | null = null

  function adaptiveChunkSize(): number {
    // EMA 采样驱动：预算的 80% 留给任务，余量给浏览器
    const size = Math.floor((frameBudgetMs * 0.8) / Math.max(emaTaskMs, 0.01))
    return Math.max(1, Math.min(maxChunk, size))
  }

  function notifyIdleIfDrained(): void {
    if (queue.length === 0 && idleResolve !== null) {
      const r = idleResolve
      idleResolve = null
      r()
    }
  }

  async function loop(): Promise<void> {
    if (running) return
    running = true
    try {
      while (queue.length > 0 && !disposed) {
        await frameBoundary()
        const sliceStart = performance.now()
        let chunk = adaptiveChunkSize()
        while (queue.length > 0 && chunk > 0 && !disposed) {
          // 队首即最高优先级（入队时已按优先级+FIFO 排序）
          const task = queue.shift()!
          if (task.cancelled) {
            task.resolve()
            continue
          }
          const taskStart = performance.now()
          try {
            await task.run()
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
          // await 之后（可能跨了微任务 flush / 宏任务让出）重新检查预算
          if (performance.now() - sliceStart >= frameBudgetMs) break
        }
        // 预算耗尽但队列未空：让出主线程（特性检测降级链），避免阻塞输入
        if (queue.length > 0 && performance.now() - sliceStart >= frameBudgetMs) {
          await yieldToBrowser()
        }
      }
    } finally {
      running = false
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
      cancelled: false,
      resolve: resolveFn,
      reject: rejectFn,
    }
    // 按优先级插入，同级 FIFO
    let idx = queue.length
    while (idx > 0 && PRIORITY_ORDER[queue[idx - 1]!.priority] > PRIORITY_ORDER[task.priority]) {
      idx--
    }
    queue.splice(idx, 0, queued)
    void loop()
    return {
      id: queued.id,
      cancel: () => {
        queued.cancelled = true
      },
      done,
    }
  }

  return {
    schedule,
    cancelAll: () => {
      for (const t of queue.splice(0)) {
        t.cancelled = true
        t.resolve()
      }
      notifyIdleIfDrained()
    },
    whenIdle: () => {
      if (queue.length === 0) return Promise.resolve()
      return new Promise((resolve) => {
        idleResolve = resolve
      })
    },
    dispose: () => {
      disposed = true
      queue.length = 0
      notifyIdleIfDrained()
    },
    get pending() {
      return queue.length
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
