import { reactive, watch } from 'vue'

export interface FlagDef {
  key: string
  label: string
  scene: string
}

export const FLAG_DEFS: FlagDef[] = [
  { key: 'scope', label: 'A1 effectScope 统一注册/销毁', scene: 'A' },
  { key: 'chunk', label: 'A2 rAF+MessageChannel 分片调度器', scene: 'A' },
  { key: 'computed', label: 'B1 computed 合并重复派生', scene: 'B' },
  { key: 'flush', label: 'B2 watch flush 时机分流', scene: 'B' },
  { key: 'memo', label: 'B3 LRU 记忆化(对象键)', scene: 'B' },
  { key: 'vmemo', label: 'T1 v-memo 表格行缓存', scene: 'T' },
  { key: 'shallow', label: 'C1 shallowRef+triggerRef 批量写', scene: 'C' },
  { key: 'batch', label: 'C2 流聚批+背压', scene: 'C' },
  { key: 'pause', label: 'C3 watcher pause/resume', scene: 'C' },
]

export type Flags = Record<string, boolean>

export const flags: Flags = reactive(Object.fromEntries(FLAG_DEFS.map((d) => [d.key, false])))

function readFromUrl() {
  const params = new URLSearchParams(location.search)
  const raw = params.get('flags')
  if (raw === 'all') {
    for (const d of FLAG_DEFS) flags[d.key] = true
    return
  }
  if (raw) {
    for (const k of raw.split(',')) {
      if (k in flags) flags[k] = true
    }
  }
}

readFromUrl()

watch(
  flags,
  () => {
    const on = FLAG_DEFS.filter((d) => flags[d.key]).map((d) => d.key)
    const url = new URL(location.href)
    if (on.length) url.searchParams.set('flags', on.join(','))
    else url.searchParams.delete('flags')
    history.replaceState(null, '', url)
  },
  { deep: true },
)

export function setAll(value: boolean) {
  for (const d of FLAG_DEFS) flags[d.key] = value
}

/** 以指定开关集合执行一次函数, 结束后恢复原开关(供 A/B 基准复跑) */
export async function withFlags<T>(patch: Record<string, boolean>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, boolean> = {}
  for (const k of Object.keys(patch)) saved[k] = flags[k]
  Object.assign(flags, patch)
  try {
    return await fn()
  } finally {
    Object.assign(flags, saved)
  }
}
