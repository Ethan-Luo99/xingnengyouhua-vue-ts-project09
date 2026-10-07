/**
 * 场景 C 三种高频来源：
 * 1. setInterval 定时器（100ms）
 * 2. rAF 帧回调（每帧 1 条）
 * 3. 模拟流式推送：每帧 50 条，每条经 MessageChannel 独立宏任务送达
 *    （模拟 WebSocket message 事件：每条消息一个宏任务，框架不会跨宏任务去重）
 */

export interface StreamMsg {
  seq: number
  source: 'timer' | 'raf' | 'stream'
  payload: number
  at: number
}

export const STREAM_PER_FRAME = 50

export interface Sources {
  start: () => void
  stop: () => void
  readonly running: boolean
}

export interface SourceOptions {
  /** 叠加的固定频率定时器（selftest 用 16ms；不提供则只有 100ms 定时器） */
  extraIntervalMs?: number
  /** 消息一经生成（seq 分配）即回调，无论之后是否被背压丢弃，供 seq 对账 */
  onEmit?: (m: StreamMsg) => void
}

export function createSources(
  onMessage: (m: StreamMsg) => void,
  opts: SourceOptions = {},
): Sources {
  let seq = 0
  let running = false
  let timerId = 0
  let extraTimerId = 0
  let rafId = 0
  const channel = new MessageChannel()
  const pending: StreamMsg[] = []

  channel.port1.onmessage = () => {
    const m = pending.shift()
    if (m !== undefined && running) onMessage(m)
  }

  function makeMsg(source: StreamMsg['source']): StreamMsg {
    const m = {
      seq: seq++,
      source,
      payload: (seq * 2654435761) % 100000,
      at: performance.now(),
    }
    opts.onEmit?.(m)
    return m
  }

  function emitStreamBurst(): void {
    for (let i = 0; i < STREAM_PER_FRAME; i++) {
      pending.push(makeMsg('stream'))
      channel.port2.postMessage(null)
    }
  }

  function rafLoop(): void {
    if (!running) return
    onMessage(makeMsg('raf'))
    emitStreamBurst()
    rafId = requestAnimationFrame(rafLoop)
  }

  return {
    start: () => {
      if (running) return
      running = true
      timerId = window.setInterval(() => onMessage(makeMsg('timer')), 100)
      if (opts.extraIntervalMs !== undefined) {
        extraTimerId = window.setInterval(() => onMessage(makeMsg('timer')), opts.extraIntervalMs)
      }
      rafId = requestAnimationFrame(rafLoop)
    },
    stop: () => {
      running = false
      clearInterval(timerId)
      clearInterval(extraTimerId)
      cancelAnimationFrame(rafId)
      pending.length = 0
    },
    get running() {
      return running
    },
  }
}
