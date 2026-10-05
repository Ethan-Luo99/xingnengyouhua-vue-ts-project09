import type { Ref } from 'vue'
import { countComputedRecalc } from '../../perf/obs'
import { calcStats, type Row, type SharedState, type Stats } from './store'

/**
 * 场景 B 基线（未优化）实现 —— 保留，通过开关切换。
 * 反模式集合：
 * 1. 每个扇出函数都命令式重算全表聚合（O(n) x 320）
 * 2. sync watcher：每次响应式写入当场执行（320 次连锁 + 布局抖动）
 * 3. 命令式维护 stats 快照（手写缓存，会过期）
 * 4. 渲染用不稳定 tick prop 强制全表 300 行重渲染
 * 5. 隐藏面板 watcher 常开（不可见 UI 也持续执行）
 */

export interface FanoutCtx {
  rows: Row[]
  shared: SharedState
  statsSource: Ref<Stats>
  affectedRows: Set<number>
}

export function fanOutBaseline(ctx: FanoutCtx, count: number, affected: number): void {
  for (let i = 0; i < count; i++) {
    const idx = (i * 7) % affected
    const row = ctx.rows[idx]!
    // 共享响应式数据读写交错
    row.value += 1
    row.delta = row.value - 100
    if (i % 6 === 0) row.status = row.value % 3 === 0 ? 'crit' : 'ok'
    ctx.affectedRows.add(idx)
    // 链信号：sync watcher 连锁 chainBus -> chain2 -> chain3
    ctx.shared.chainBus.value = i
    // 反模式 1：每个函数都命令式重算全表聚合
    countComputedRecalc()
    const stats = calcStats(ctx.rows)
    // 反模式 3：命令式写回快照（触发 stats watcher）
    ctx.statsSource.value = stats
    // 读写交错：读刚写的共享状态再写另一个
    ctx.shared.mirror.value = (row.value + stats.total) % 997
  }
}

/** 基线 describeRow：直接调用（无记忆化），供对照 */
export function describeRowDirect(row: Row, describe: (r: Row) => string): string {
  return describe(row)
}
