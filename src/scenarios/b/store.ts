import { reactive, ref } from 'vue'

/** 场景 B 数据：300 行 x 8 列 */
export interface Row {
  id: number
  name: string
  category: string
  value: number
  status: string
  score: number
  delta: number
  tag: string
}

export const ROW_COUNT = 300
export const FANOUT_COUNT = 320
/** 扇出实际影响的行数（渲染边界验收：优化态只应重渲染这些行） */
export const AFFECTED_ROWS = 48

const CATEGORIES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
const STATUSES = ['ok', 'warn', 'crit']

export function makeRows(): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < ROW_COUNT; i++) {
    rows.push(
      reactive({
        id: i,
        name: `row-${i}`,
        category: CATEGORIES[i % CATEGORIES.length]!,
        value: (i * 7919) % 1000,
        status: STATUSES[i % STATUSES.length]!,
        score: ((i * 104729) % 10000) / 100,
        delta: 0,
        tag: `t${i % 12}`,
      }) as Row,
    )
  }
  return rows
}

export interface Stats {
  total: number
  avg: number
  max: number
  critCount: number
}

/** 全表聚合（O(n)）：baseline 每次扇出函数都重算；optimized 由 computed 缓存 */
export function calcStats(rows: Row[]): Stats {
  let total = 0
  let max = -Infinity
  let critCount = 0
  for (const r of rows) {
    total += r.value
    if (r.value > max) max = r.value
    if (r.status === 'crit') critCount++
  }
  return { total, avg: total / rows.length, max, critCount }
}

/** 扇出共享状态（读写交错的载体） */
export function createSharedState() {
  return {
    chainBus: ref(0),
    chain2: ref(0),
    chain3: ref(0),
    mirror: ref(0),
    /** baseline 命令式维护的统计快照 */
    statsRef: ref<Stats>({ total: 0, avg: 0, max: 0, critCount: 0 }),
    /** 强制全表重渲染的不稳定 prop（baseline 反模式） */
    tick: ref(0),
    /** DOM 测量结果（flush 时机演示） */
    measuredHeight: ref(0),
    /** 隐藏面板文本（pause/resume 演示） */
    detailsText: ref(''),
  }
}

export type SharedState = ReturnType<typeof createSharedState>

/** 纯函数：行描述文本（LRU 记忆化的对象入参演示）。只读取稳定字段，不含 value */
export function describeRow(row: Row): string {
  // 真实格式化工作：多字段拼接 + 数值格式化
  const s = `${row.name}|${row.category}|${row.status}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003
  return `#${h.toString(36)}-${row.score.toFixed(1)}`
}
