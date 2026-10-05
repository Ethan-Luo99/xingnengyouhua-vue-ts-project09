import { reactive } from 'vue'

/** 一次基准运行的同口径指标快照 */
export type Snapshot = Record<string, number | string>

export interface BenchMetricDef {
  key: string
  label: string
  /** 阈值判定: 返回 true 表示达标 */
  pass?: (optimized: number) => boolean
}

export interface BenchState {
  running: boolean
  baseline?: Snapshot
  optimized?: Snapshot
  note?: string
}

export const benchStates = reactive<Record<string, BenchState>>({})

type CompareRunner = (onProgress?: (msg: string) => void) => Promise<{ baseline: Snapshot; optimized: Snapshot; note?: string }>

const runners: Record<string, CompareRunner> = {}

export function registerBenchmark(name: string, runner: CompareRunner) {
  runners[name] = runner
  if (!benchStates[name]) benchStates[name] = { running: false }
}

export function unregisterBenchmark(name: string) {
  delete runners[name]
}

export async function runCompare(name: string, onProgress?: (msg: string) => void): Promise<void> {
  const runner = runners[name]
  if (!runner) throw new Error(`benchmark ${name} 未注册(请先切到对应场景页)`)
  const state = benchStates[name]!
  if (state.running) return
  state.running = true
  state.note = '运行中...'
  try {
    const { baseline, optimized, note } = await runner(onProgress)
    state.baseline = baseline
    state.optimized = optimized
    state.note = note ?? ''
  } catch (e) {
    state.note = `运行失败: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    state.running = false
  }
}

export function fmt(v: number | string | undefined): string {
  if (v === undefined) return '—'
  if (typeof v === 'string') return v
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(1)
}
