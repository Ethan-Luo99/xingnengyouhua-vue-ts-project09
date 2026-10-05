import { shallowRef, triggerRef, type ShallowRef } from 'vue'
import { countFlush } from '../../perf/obs'
import type { StreamBuffer } from '../../perf/stream'
import type { StreamMsg } from './sources'

/**
 * 场景 C 优化实现：
 * 1. 消息进普通 JS 缓冲（背压：超限按策略丢弃），不进响应式系统
 * 2. 单个 rAF 消费者每帧 drain 一次 → 渲染频率封顶帧率
 * 3. shallowRef + triggerRef 批量写入：一帧一次触发
 */

export const LIST_CAP = 100

export interface OptimizedState {
  list: ShallowRef<StreamMsg[]>
  received: number
}

export function createOptimizedState(): OptimizedState {
  return {
    list: shallowRef<StreamMsg[]>([]),
    received: 0,
  }
}

export function createBatchedWriter(state: OptimizedState, buffer: StreamBuffer<StreamMsg>) {
  /** 消息入口：只进缓冲，零响应式写入 */
  function onMessage(msg: StreamMsg): void {
    buffer.push(msg)
    state.received++
  }

  /** rAF 消费者：每帧最多一次批量写入 + 一次 triggerRef */
  function drainFrame(): void {
    const msgs = buffer.drain()
    if (msgs.length === 0) return
    const list = state.list.value
    list.push(...msgs)
    if (list.length > LIST_CAP) list.splice(0, list.length - LIST_CAP)
    triggerRef(state.list)
    countFlush() // 每帧一轮
  }

  return { onMessage, drainFrame }
}
