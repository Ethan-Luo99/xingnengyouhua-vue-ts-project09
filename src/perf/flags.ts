import { reactive, computed } from 'vue'

/**
 * 9 个优化手段的独立开关。
 * 每个开关可通过 URL 参数（?scope=0&sched=1...）或面板切换。
 * 全部关闭 = 未优化基线；基线代码路径始终保留，由开关在运行时选择。
 */
export interface PerfFlags {
  /** 1. effectScope + onScopeDispose 统一管理场景a副作用 */
  scope: boolean
  /** 2. watcher pause()/resume() 用于隐藏/离屏分支 */
  pause: boolean
  /** 3. shallowRef + triggerRef 批量写入（场景c） */
  shallow: boolean
  /** 4. computed 合并重复派生（场景b） */
  computed: boolean
  /** 5. watch flush 时机分流（禁 sync 常规监听，DOM 测量用 post） */
  flush: boolean
  /** 6. v-memo 优化 300x8 表格 */
  memo: boolean
  /** 7. rAF + MessageChannel 自适应分片调度器 */
  sched: boolean
  /** 8. LRU 记忆化（对象入参键） */
  lru: boolean
  /** 9. 流数据聚批 + 背压 */
  batch: boolean
}

export const FLAG_KEYS = [
  'scope',
  'pause',
  'shallow',
  'computed',
  'flush',
  'memo',
  'sched',
  'lru',
  'batch',
] as const

export type FlagKey = (typeof FLAG_KEYS)[number]

export const FLAG_LABELS: Record<FlagKey, string> = {
  scope: '1 effectScope 生命周期',
  pause: '2 watcher pause/resume',
  shallow: '3 shallowRef+triggerRef',
  computed: '4 computed 合并派生',
  flush: '5 watch flush 分流',
  memo: '6 v-memo 表格',
  sched: '7 自适应分片调度器',
  lru: '8 LRU 记忆化',
  batch: '9 流聚批+背压',
}

function readFlagsFromUrl(): PerfFlags {
  const params = new URLSearchParams(location.search)
  const flags = {} as PerfFlags
  for (const key of FLAG_KEYS) {
    const raw = params.get(key)
    // 默认全部开启（优化态）；显式 =0 关闭；?baseline=1 一键全关
    flags[key] = raw === null ? params.get('baseline') !== '1' : raw !== '0'
  }
  return flags
}

export const flags = reactive<PerfFlags>(readFlagsFromUrl())

/** 复跑对比时的强制覆盖（null = 使用面板/URL 的当前值） */
export const flagOverride = reactive<{ value: PerfFlags | null }>({ value: null })

export function effectiveFlags(): PerfFlags {
  return flagOverride.value ?? flags
}

export function allFlagsOff(): PerfFlags {
  const out = {} as PerfFlags
  for (const key of FLAG_KEYS) out[key] = false
  return out
}

export function allFlagsOn(): PerfFlags {
  const out = {} as PerfFlags
  for (const key of FLAG_KEYS) out[key] = true
  return out
}

export function syncFlagsToUrl(): void {
  const params = new URLSearchParams(location.search)
  params.delete('baseline')
  for (const key of FLAG_KEYS) params.set(key, flags[key] ? '1' : '0')
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`)
}

export const baselineMode = computed(() => FLAG_KEYS.every((k) => !effectiveFlags()[k]))
