import { reactive } from 'vue'
import { countFlush } from '../../perf/obs'
import type { StreamMsg } from './sources'

/**
 * 场景 C 基线（未优化）实现 —— 保留，通过开关切换。
 * 每条消息到达即写响应式状态：50 条/帧 = 50 轮微任务 flush/帧，
 * 每轮都重渲染消息列表。无聚合、无背压、无帧率封顶。
 */

export const LIST_CAP = 100

export function createBaselineState() {
  return reactive({
    list: [] as StreamMsg[],
    received: 0,
  })
}

export type BaselineState = ReturnType<typeof createBaselineState>

export function handleMessageBaseline(state: BaselineState, msg: StreamMsg): void {
  state.list.push(msg)
  if (state.list.length > LIST_CAP) state.list.shift()
  state.received++
  countFlush() // 每条消息一个宏任务 → 一轮 flush
}
