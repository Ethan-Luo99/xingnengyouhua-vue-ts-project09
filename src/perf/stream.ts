/**
 * 手段 9：流数据聚批 + 背压缓冲。
 *
 * - 消息先入普通 JS 缓冲（不进响应式系统），由 rAF 消费者每帧 drain 一次，
 *   渲染频率天然封顶在帧率。
 * - 背压：缓冲超过 maxSize 时按策略丢弃过期消息：
 *   - 'drop-oldest'：丢最旧（默认，实时流语义：宁丢旧帧不堵新帧）
 *   - 'drop-newest'：拒收新消息（保序场景）
 *   - 'unbounded'：不丢弃（对照组，演示内存/积压风险）
 * - dropped 计数外露，供面板展示丢弃量。
 */

export type DropPolicy = 'drop-oldest' | 'drop-newest' | 'unbounded'

export interface StreamBuffer<T> {
  push: (msg: T) => void
  pushBatch: (msgs: T[]) => void
  /** 每帧调用一次：取走全部缓冲消息 */
  drain: () => T[]
  clear: () => void
  readonly size: number
  readonly dropped: number
  readonly received: number
  policy: DropPolicy
  maxSize: number
}

export function createStreamBuffer<T>(maxSize = 240, policy: DropPolicy = 'drop-oldest'): StreamBuffer<T> {
  let buf: T[] = []
  let dropped = 0
  let received = 0

  const buffer: StreamBuffer<T> = {
    push(msg: T) {
      received++
      if (buffer.policy !== 'unbounded' && buf.length >= buffer.maxSize) {
        if (buffer.policy === 'drop-oldest') {
          buf.shift()
          dropped++
        } else {
          // drop-newest：拒收
          dropped++
          return
        }
      }
      buf.push(msg)
    },
    pushBatch(msgs: T[]) {
      for (const m of msgs) buffer.push(m)
    },
    drain(): T[] {
      if (buf.length === 0) return []
      const out = buf
      buf = []
      return out
    },
    clear() {
      buf = []
      dropped = 0
      received = 0
    },
    get size() {
      return buf.length
    },
    get dropped() {
      return dropped
    },
    get received() {
      return received
    },
    policy,
    maxSize,
  }
  return buffer
}
