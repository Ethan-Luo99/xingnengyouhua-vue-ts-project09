/**
 * 流数据聚批 + 背压
 * - 渲染频率封顶帧率: 单一 rAF 消费者, 每帧至多 flush 一次
 * - 背压: 缓冲区容量上限, 超限按策略处置
 * - 过期丢弃: flush 时丢弃窗口内过期的消息(策略可配置)
 */

export type DropPolicy = 'none' | 'drop-oldest' | 'drop-newest' | 'expire'

export interface BatcherOptions<T> {
  capacity: number
  policy: DropPolicy
  /** policy = expire 时, 超过该毫秒数的消息在 flush 时丢弃 */
  expireMs?: number
  flush: (batch: T[]) => void
}

export interface BatcherStats {
  received: number
  accepted: number
  dropped: number
  expired: number
  flushes: number
  flushedMsgs: number
}

export interface StreamBatcher<T> {
  push(msg: T): boolean
  start(): void
  stop(): void
  readonly stats: BatcherStats
  readonly buffered: number
}

export function createStreamBatcher<T extends { ts: number }>(opts: BatcherOptions<T>): StreamBatcher<T> {
  let buffer: T[] = []
  let rafId = 0
  let running = false
  const stats: BatcherStats = { received: 0, accepted: 0, dropped: 0, expired: 0, flushes: 0, flushedMsgs: 0 }

  function push(msg: T): boolean {
    stats.received++
    if (buffer.length >= opts.capacity) {
      // 背压: 容量已满
      if (opts.policy === 'drop-oldest') {
        buffer.shift()
        stats.dropped++
      } else {
        // none / drop-newest / expire: 拒绝接收, 向生产者施加背压
        stats.dropped++
        return false
      }
    }
    buffer.push(msg)
    stats.accepted++
    return true
  }

  function drain() {
    if (!running) return
    if (buffer.length) {
      let batch = buffer
      buffer = []
      if (opts.policy === 'expire' && opts.expireMs !== undefined) {
        const now = performance.now()
        const fresh: T[] = []
        for (const m of batch) {
          if (now - m.ts <= opts.expireMs) fresh.push(m)
          else stats.expired++
        }
        batch = fresh
      }
      if (batch.length) {
        stats.flushes++
        stats.flushedMsgs += batch.length
        opts.flush(batch)
      }
    }
    rafId = requestAnimationFrame(drain)
  }

  return {
    push,
    start() {
      if (running) return
      running = true
      rafId = requestAnimationFrame(drain)
    },
    stop() {
      running = false
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
    },
    stats,
    get buffered() {
      return buffer.length
    },
  }
}
