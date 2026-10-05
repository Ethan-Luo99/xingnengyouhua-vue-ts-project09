/**
 * rAF + MessageChannel 自适应分片调度器
 * - 8ms 帧预算(可配), 帧边界自然让出, Vue 的微任务 flush 在片间发生
 * - 动态分片粒度: 单元耗时 EMA 采样 -> 每片单元数自适应, 带上限钳制
 * - 让出原语降级链: scheduler.yield -> MessageChannel -> setTimeout(0)
 * - 支持取消(AbortSignal / cancelAll)与错误传播(每任务 Promise reject, 不拖垮队列)
 * - 重入保护: 分片任务内写响应式状态触发同步连锁时, drain 不会重入
 */

export type YieldMode = 'scheduler.yield' | 'messagechannel' | 'settimeout'

export function detectYieldMode(): YieldMode {
  const g = globalThis as { scheduler?: { yield?: () => Promise<void> }; MessageChannel?: unknown }
  if (typeof g.scheduler?.yield === 'function') return 'scheduler.yield'
  if (typeof g.MessageChannel === 'function') return 'messagechannel'
  return 'settimeout'
}

export const yieldMode: YieldMode = detectYieldMode()

function yieldTask(): Promise<void> {
  if (yieldMode === 'scheduler.yield') {
    return (globalThis as unknown as { scheduler: { yield: () => Promise<void> } }).scheduler.yield()
  }
  if (yieldMode === 'messagechannel') {
    return new Promise((resolve) => {
      const ch = new MessageChannel()
      ch.port1.onmessage = () => {
        ch.port1.close()
        ch.port2.close()
        resolve()
      }
      ch.port2.postMessage(null)
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface Task<T = unknown> {
  id: number
  priority: number
  fn: () => T | Promise<T>
  signal?: AbortSignal
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

export interface SchedulerOptions {
  /** 单片预算 ms, 默认 8 (60Hz 下给浏览器留 8ms+) */
  budgetMs?: number
  /** true: 以 rAF 为节拍(可视化进度); false: 宏任务链(后台计算, 空标签页不被节流) */
  frameAligned?: boolean
  /** 单片单元数上限, 防突发 */
  maxChunk?: number
}

export interface SchedulerStats {
  executed: number
  cancelled: number
  failed: number
  slices: number
  maxSliceMs: number
  chunkSize: number
  reentrantHits: number
}

function abortError(): Error {
  return new Error('task cancelled')
}

export class ChunkScheduler {
  private queue: Task[] = []
  private seq = 0
  private scheduled = false
  private draining = false
  private reentrant = false
  private rafId = 0
  private disposed = false
  private idleWaiters: (() => void)[] = []
  private unitCostEma = 0.2
  private readonly budgetMs: number
  private readonly frameAligned: boolean
  private readonly maxChunk: number
  readonly stats: SchedulerStats = {
    executed: 0,
    cancelled: 0,
    failed: 0,
    slices: 0,
    maxSliceMs: 0,
    chunkSize: 1,
    reentrantHits: 0,
  }

  constructor(opts: SchedulerOptions = {}) {
    this.budgetMs = opts.budgetMs ?? 8
    this.frameAligned = opts.frameAligned ?? true
    this.maxChunk = opts.maxChunk ?? 64
  }

  get pending(): number {
    return this.queue.length
  }

  enqueue<T>(fn: () => T | Promise<T>, opts: { priority?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('scheduler disposed'))
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = {
        id: ++this.seq,
        priority: opts.priority ?? 1,
        fn,
        signal: opts.signal,
        resolve,
        reject,
      }
      if (opts.signal?.aborted) {
        this.stats.cancelled++
        reject(abortError())
        return
      }
      opts.signal?.addEventListener('abort', () => this.cancel(task.id), { once: true })
      // 按 (priority, id) 二分插入, 小值先执行
      let lo = 0
      let hi = this.queue.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        const m = this.queue[mid]!
        if (m.priority < task.priority || (m.priority === task.priority && m.id < task.id)) lo = mid + 1
        else hi = mid
      }
      this.queue.splice(lo, 0, task as Task)
      this.kick()
    })
  }

  cancel(id: number) {
    const idx = this.queue.findIndex((t) => t.id === id)
    if (idx >= 0) {
      const [t] = this.queue.splice(idx, 1)
      this.stats.cancelled++
      t?.reject(abortError())
    }
  }

  cancelAll() {
    const pending = this.queue.splice(0)
    for (const t of pending) {
      this.stats.cancelled++
      t.reject(abortError())
    }
  }

  /** 队列清空时 resolve (供基准测试等待全部任务完成) */
  whenIdle(): Promise<void> {
    if (!this.queue.length && !this.draining) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  dispose() {
    this.disposed = true
    this.cancelAll()
    if (this.rafId) cancelAnimationFrame(this.rafId)
  }

  private kick() {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    if (this.frameAligned) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0
        void this.drain()
      })
    } else {
      void yieldTask().then(() => this.drain())
    }
  }

  private async drain() {
    // 重入保护: 分片任务内写响应式状态若引发同步连锁再次进入 drain, 只标记不重入
    if (this.draining) {
      this.reentrant = true
      this.stats.reentrantHits++
      return
    }
    this.draining = true
    this.scheduled = false
    const sliceStart = performance.now()
    const deadline = sliceStart + this.budgetMs
    // 动态分片粒度: 预算 / 单元耗时 EMA, 钳制 [1, maxChunk]
    const chunk = Math.max(1, Math.min(this.maxChunk, Math.round(this.budgetMs / Math.max(this.unitCostEma, 0.01))))
    this.stats.chunkSize = chunk
    let n = 0
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!
        if (task.signal?.aborted) {
          this.stats.cancelled++
          task.reject(abortError())
          continue
        }
        const t0 = performance.now()
        try {
          const r = task.fn()
          if (r instanceof Promise) r.then(task.resolve, task.reject)
          else task.resolve(r)
          this.stats.executed++
        } catch (e) {
          // 错误传播: 单任务失败 reject 自身 Promise, 不中断队列
          this.stats.failed++
          task.reject(e)
        }
        const dt = performance.now() - t0
        this.unitCostEma = this.unitCostEma * 0.7 + dt * 0.3
        n++
        if (n >= chunk || performance.now() >= deadline) break
      }
    } finally {
      this.draining = false
      const sliceMs = performance.now() - sliceStart
      if (sliceMs > this.stats.maxSliceMs) this.stats.maxSliceMs = sliceMs
      this.stats.slices++
    }
    if (this.queue.length && !this.disposed) {
      // 片间让出: Vue 的 flush 微任务在下一个宏任务/rAF 之前执行, 每片少量写入被自然合并
      this.kick()
    } else if (!this.queue.length) {
      const waiters = this.idleWaiters.splice(0)
      for (const w of waiters) w()
    }
    if (this.reentrant) {
      this.reentrant = false
      if (this.queue.length) this.kick()
    }
  }
}
