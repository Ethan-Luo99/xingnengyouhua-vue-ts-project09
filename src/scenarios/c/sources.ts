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

export interface SourcesOptions {
  /** 定时器消息周期，默认 100ms（selftest 叠加场景用 16ms） */
  timerIntervalMs?: number
  /** 是否启用每帧 50 条流推送，默认 true */
  streamBurst?: boolean
}

export interface Sources {
  start: () => void
  stop: () => void
  readonly running: boolean
}

export function createSources(
  onMessage: (m: StreamMsg) => void,
  options: SourcesOptions = {},
): Sources {
  const timerIntervalMs = options.timerIntervalMs ?? 100
  const streamBurst = options.streamBurst ?? true
  let seq = 0
  let running = false
  let timerId = 0
  let rafId = 0
  const channel = new MessageChannel()
  const pending: StreamMsg[] = []

  channel.port1.onmessage = () => {
    const m = pending.shift()
    if (m !== undefined && running) onMessage(m)
  }

  function makeMsg(source: StreamMsg['source']): StreamMsg {
    return {
      seq: seq++,
      source,
      payload: (seq * 2654435761) % 100000,
      at: performance.now(),
    }
  }

  function emitStreamBurst(): void {
    if (!streamBurst) return
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
      timerId = window.setInterval(() => onMessage(makeMsg('timer')), timerIntervalMs)
      rafId = requestAnimationFrame(rafLoop)
    },
    stop: () => {
      running = false
      clearInterval(timerId)
      cancelAnimationFrame(rafId)
      pending.length = 0
    },
    get running() {
      return running
    },
  }
}
