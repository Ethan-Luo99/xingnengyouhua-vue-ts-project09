import { reactive } from 'vue'

/**
 * 复跑编排：面板触发“一键复跑”，场景组件挂载后自动执行并回传指标。
 * 指标全部来自 obs.ts 的真实采集（PerformanceObserver / mark-measure / 计数器），
 * 不允许硬编码。
 */

export type ScenarioId = 'a' | 'b' | 'c'

export type RunMetrics = Record<string, number>

export interface ScenarioResult {
  baseline: RunMetrics | null
  current: RunMetrics | null
}

export const runStore = reactive({
  /** 场景组件挂载后是否自动执行基准运行 */
  autoRun: false,
  /** 当前正在等待回传的场景 */
  pending: null as ScenarioId | null,
  results: {
    a: { baseline: null, current: null },
    b: { baseline: null, current: null },
    c: { baseline: null, current: null },
  } as Record<ScenarioId, ScenarioResult>,
  /** 面板展示用：最近一次运行状态 */
  status: 'idle' as 'idle' | 'running-baseline' | 'running-current',
})

let resolver: ((m: RunMetrics) => void) | null = null

export function expectRun(): Promise<RunMetrics> {
  return new Promise((resolve) => {
    resolver = resolve
  })
}

export function completeRun(metrics: RunMetrics): void {
  if (resolver !== null) {
    const r = resolver
    resolver = null
    r(metrics)
  }
}

/* 场景 A 卸载残留探针通道 */
let probeResolver: ((m: RunMetrics) => void) | null = null

export function expectProbe(): Promise<RunMetrics> {
  return new Promise((resolve) => {
    probeResolver = resolve
  })
}

export function completeProbe(metrics: RunMetrics): void {
  if (probeResolver !== null) {
    const r = probeResolver
    probeResolver = null
    r(metrics)
  }
}

/** 场景运行窗口内的指标采集器：begin 快照，end 计算增量 */
export interface RunWindow {
  startTime: number
  renders: number
  rowRenders: number
  watchTriggers: number
  computedRecalcs: number
  flushes: number
}

import { obs, inpP95 } from './obs'

export function beginWindow(): RunWindow {
  return {
    startTime: performance.now(),
    renders: obs.renders,
    rowRenders: obs.rowRenders,
    watchTriggers: obs.watchTriggers,
    computedRecalcs: obs.computedRecalcs,
    flushes: obs.flushes,
  }
}

export function collectWindow(w: RunWindow): RunMetrics {
  const end = performance.now()
  const overlaps = (t: { startTime: number; duration: number }): boolean =>
    t.startTime < end && t.startTime + t.duration > w.startTime
  const longtasks = obs.longtasks.filter(overlaps)
  const loafs = obs.loafs.filter(overlaps)
  const events = obs.events.filter(overlaps)
  return {
    windowMs: end - w.startTime,
    longtasks: longtasks.length,
    longtaskTotalMs: longtasks.reduce((a, t) => a + t.duration, 0),
    loafs: loafs.length,
    inpP95: inpP95(events),
    renders: obs.renders - w.renders,
    rowRenders: obs.rowRenders - w.rowRenders,
    watchTriggers: obs.watchTriggers - w.watchTriggers,
    computedRecalcs: obs.computedRecalcs - w.computedRecalcs,
    flushes: obs.flushes - w.flushes,
  }
}
