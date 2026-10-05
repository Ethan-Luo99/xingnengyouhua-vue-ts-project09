import type { Ref } from 'vue'
import type { Row, SharedState, Stats } from './store'

/**
 * 场景 B 优化实现：
 * 1. 写入收敛：扇出循环只写源状态，派生结果由 computed 惰性推导
 * 2. computed 合并重复派生：同一 flush 内多次读取只算一次（循环外读一次）
 * 3. watch flush 分流：常规 pre、DOM 测量 post、禁 sync
 * 4. v-memo + 稳定 props：只有受影响行重渲染
 * 5. LRU 记忆化 describeRow（对象入参键）
 * 6. 隐藏面板 watcher pause/resume
 * 功能等价性：循环结束后的最终共享状态与基线完全一致。
 */

export interface FanoutCtxOpt {
  rows: Row[]
  shared: SharedState
  /** computed 派生（缓存） */
  statsSource: Ref<Stats>
  affectedRows: Set<number>
}

export function fanOutOptimized(ctx: FanoutCtxOpt, count: number, affected: number): void {
  let lastRow: Row | null = null
  for (let i = 0; i < count; i++) {
    const idx = (i * 7) % affected
    const row = ctx.rows[idx]!
    // 只写源状态；不在写循环内读派生（避免 computed 反复变脏重算）
    row.value += 1
    row.delta = row.value - 100
    if (i % 6 === 0) row.status = row.value % 3 === 0 ? 'crit' : 'ok'
    ctx.affectedRows.add(idx)
    ctx.shared.chainBus.value = i
    lastRow = row
  }
  // 循环外读一次派生（computed 缓存：本 flush 只重算一次），写一次 mirror
  const stats = ctx.statsSource.value
  ctx.shared.mirror.value = ((lastRow?.value ?? 0) + stats.total) % 997
}
