import { reactive, watch, computed, type WatchHandle, type WatchCallback, type WatchSource, type WatchOptions } from 'vue'

/**
 * 零依赖可观测性核心：
 * - PerformanceObserver: longtask / event(INP) / long-animation-frame
 * - performance.mark/measure 场景阶段埋点
 * - render / watcher / computed 计数器（显式插桩，非 DevTools）
 * - rAF 差值法帧监控（帧间隔、掉帧、每帧 JS 耗时）
 * - performance.memory 堆采样（Chrome）
 */

export interface LongTaskRec {
  startTime: number
  duration: number
}
export interface EventRec {
  startTime: number
  duration: number
  processingStart: number
  processingEnd: number
  name: string
}
export interface LoafRec {
  startTime: number
  duration: number
}

const MAX_ENTRIES = 2000

export const obs = reactive({
  longtasks: [] as LongTaskRec[],
  events: [] as EventRec[],
  loafs: [] as LoafRec[],
  observerErrors: [] as string[],
  /** 计数器：显式插桩 */
  renders: 0,
  rowRenders: 0,
  watchTriggers: 0,
  computedRecalcs: 0,
  flushes: 0,
})

const observers: PerformanceObserver[] = []

function pushBounded<T>(arr: T[], item: T): void {
  arr.push(item)
  if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES)
}

export function startObservers(): void {
  if (observers.length > 0) return
  const defs: Array<[string, (e: PerformanceEntry) => void]> = [
    [
      'longtask',
      (e) => pushBounded(obs.longtasks, { startTime: e.startTime, duration: e.duration }),
    ],
    [
      'event',
      (e) => {
        const et = e as PerformanceEventTiming
        pushBounded(obs.events, {
          startTime: et.startTime,
          duration: et.duration,
          processingStart: et.processingStart,
          processingEnd: et.processingEnd,
          name: et.name,
        })
      },
    ],
    [
      'long-animation-frame',
      (e) => pushBounded(obs.loafs, { startTime: e.startTime, duration: e.duration }),
    ],
  ]
  for (const [type, cb] of defs) {
    try {
      const o = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) cb(entry)
      })
      // event 默认 durationThreshold=104ms 会漏报快速交互；16ms 是规范允许的最小值
      const init: PerformanceObserverInit =
        type === 'event'
          ? ({ type, buffered: true, durationThreshold: 16 } as PerformanceObserverInit)
          : ({ type, buffered: true } as PerformanceObserverInit)
      o.observe(init)
      observers.push(o)
    } catch {
      obs.observerErrors.push(`observer 不支持: ${type}`)
    }
  }
}

export function stopObservers(): void {
  for (const o of observers) o.disconnect()
  observers.length = 0
}

/* ---------- mark / measure ---------- */

export function mark(name: string): void {
  performance.mark(name)
}

export function measure(name: string, startMark: string, endMark: string): number {
  performance.measure(name, startMark, endMark)
  const entries = performance.getEntriesByName(name, 'measure')
  return entries.length > 0 ? entries[entries.length - 1]!.duration : 0
}

export function clearMarks(): void {
  performance.clearMarks()
  performance.clearMeasures()
}

/* ---------- 计数器插桩 ---------- */

export function countRender(): void {
  obs.renders++
}
export function countRowRender(): void {
  obs.rowRenders++
}
export function countFlush(): void {
  obs.flushes++
}
export function countComputedRecalc(): void {
  obs.computedRecalcs++
}

/** watch 插桩包装：统计触发次数，行为与原生 watch 一致 */
export function trackedWatch<T>(
  source: WatchSource<T>,
  cb: WatchCallback<T, T | undefined>,
  options?: WatchOptions,
): WatchHandle {
  return watch(
    source,
    ((value: T, oldValue: T | undefined, onCleanup: () => void) => {
      obs.watchTriggers++
      cb(value, oldValue, onCleanup)
    }) as WatchCallback<T, T | undefined>,
    options,
  )
}

/** computed 插桩包装：统计真实重算次数 */
export function trackedComputed<T>(getter: () => T) {
  return computed(() => {
    obs.computedRecalcs++
    return getter()
  })
}

/* ---------- 分位数 ---------- */

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]!
}

export function inpP95(events: EventRec[]): number {
  const durations = events.map((e) => e.duration).sort((a, b) => a - b)
  return percentile(durations, 95)
}

/* ---------- 帧监控（rAF 差值法） ---------- */

export interface FrameSample {
  /** 帧间隔（rAF 时间戳差值） */
  delta: number
  /** 本帧 JS 耗时：rAF 回调起点到微任务队列（含 Vue flush）排空 */
  jsMs: number
}

export const frameMonitor = reactive({
  running: false,
  samples: [] as FrameSample[],
  frames: 0,
  dropped: 0,
  jsAvg: 0,
  jsP95: 0,
  deltaP95: 0,
})

const DROP_THRESHOLD_MS = 25 // >1.5 帧 @60Hz 视为掉帧
const FRAME_CAP = 3600 // 60s @60Hz
let rafId = 0

export function startFrameMonitor(): void {
  if (frameMonitor.running) return
  frameMonitor.running = true
  frameMonitor.samples = []
  frameMonitor.frames = 0
  frameMonitor.dropped = 0
  let last = 0
  const loop = (ts: number) => {
    if (!frameMonitor.running) return
    const jsStart = performance.now()
    if (last > 0) {
      const delta = ts - last
      frameMonitor.frames++
      if (delta > DROP_THRESHOLD_MS) frameMonitor.dropped++
      // 让当前排队的微任务（含 Vue flush）排空，测本帧 JS 总耗时
      void Promise.resolve().then(() => {
        const jsMs = performance.now() - jsStart
        frameMonitor.samples.push({ delta, jsMs })
        if (frameMonitor.samples.length > FRAME_CAP) frameMonitor.samples.shift()
      })
    }
    last = ts
    rafId = requestAnimationFrame(loop)
  }
  rafId = requestAnimationFrame(loop)
}

export function stopFrameMonitor(): void {
  frameMonitor.running = false
  cancelAnimationFrame(rafId)
  const js = frameMonitor.samples.map((s) => s.jsMs).sort((a, b) => a - b)
  const deltas = frameMonitor.samples.map((s) => s.delta).sort((a, b) => a - b)
  frameMonitor.jsAvg = js.length > 0 ? js.reduce((a, b) => a + b, 0) / js.length : 0
  frameMonitor.jsP95 = percentile(js, 95)
  frameMonitor.deltaP95 = percentile(deltas, 95)
}

/* ---------- 堆内存采样（Chrome performance.memory） ---------- */

interface PerformanceMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

export const heapMonitor = reactive({
  supported: typeof (performance as unknown as { memory?: PerformanceMemory }).memory !== 'undefined',
  samples: [] as Array<{ t: number; bytes: number }>,
  slopeBytesPerSec: 0,
  timer: 0,
})

export function sampleHeapOnce(): void {
  const mem = (performance as unknown as { memory?: PerformanceMemory }).memory
  if (!mem) return
  heapMonitor.samples.push({ t: performance.now(), bytes: mem.usedJSHeapSize })
  if (heapMonitor.samples.length > 120) heapMonitor.samples.shift()
  computeHeapSlope()
}

function computeHeapSlope(): void {
  const s = heapMonitor.samples
  if (s.length < 5) return
  // 跳过前 20% 预热样本，对剩余做最小二乘拟合
  const tail = s.slice(Math.floor(s.length / 5))
  const n = tail.length
  const t0 = tail[0]!.t
  const xs = tail.map((p) => (p.t - t0) / 1000)
  const ys = tail.map((p) => p.bytes)
  const xMean = xs.reduce((a, b) => a + b, 0) / n
  const yMean = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - xMean) * (ys[i]! - yMean)
    den += (xs[i]! - xMean) ** 2
  }
  heapMonitor.slopeBytesPerSec = den === 0 ? 0 : num / den
}

export function startHeapMonitor(): void {
  if (!heapMonitor.supported || heapMonitor.timer !== 0) return
  heapMonitor.samples = []
  sampleHeapOnce()
  heapMonitor.timer = window.setInterval(sampleHeapOnce, 2000)
}

export function stopHeapMonitor(): void {
  if (heapMonitor.timer !== 0) {
    clearInterval(heapMonitor.timer)
    heapMonitor.timer = 0
  }
}
