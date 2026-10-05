import { reactive, toRaw } from 'vue'

export interface LongTaskSample {
  startTime: number
  duration: number
}

export interface EventSample {
  name: string
  startTime: number
  duration: number
  scope: string
}

export interface LoafSample {
  startTime: number
  duration: number
  blocking: number
}

export interface FrameSample {
  t: number
  interval: number
  js: number
}

/** 命名计数器: 渲染次数 / watcher 触发 / computed 求值 / triggerRef 次数等 */
export const counters = reactive<Record<string, number>>({})

export function count(name: string, by = 1) {
  // 注意: 必须用 toRaw 读取。count() 会在渲染期间被调用(渲染计数探针),
  // 若经代理读取会被当前渲染副作用追踪, 写入又触发自身 -> 无限渲染循环
  counters[name] = ((toRaw(counters)[name] as number | undefined) ?? 0) + by
}

export function resetCounters(prefix?: string) {
  for (const k of Object.keys(counters)) {
    if (!prefix || k.startsWith(prefix)) counters[k] = 0
  }
}

export const perf = reactive({
  longTasks: [] as LongTaskSample[],
  events: [] as EventSample[],
  loafs: [] as LoafSample[],
  /** 最近若干帧样本 (rAF 差值法) */
  frames: [] as FrameSample[],
  heapMB: 0,
  supported: {
    longtask: false,
    event: false,
    loaf: false,
    memory: false,
    schedulerYield: false,
  },
})

const MAX_KEEP = 2000
const FRAME_KEEP = 1200

function pushCapped<T>(arr: T[], item: T, keep: number) {
  arr.push(item)
  if (arr.length > keep) arr.splice(0, arr.length - keep)
}

let started = false

export function startObservers() {
  if (started) return
  started = true

  perf.supported.schedulerYield =
    'scheduler' in globalThis &&
    typeof (globalThis as { scheduler?: { yield?: unknown } }).scheduler?.yield === 'function'

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        pushCapped(perf.longTasks, { startTime: e.startTime, duration: e.duration }, MAX_KEEP)
      }
    }).observe({ entryTypes: ['longtask'] })
    perf.supported.longtask = true
  } catch {
    /* 浏览器不支持 longtask */
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const target = (e as PerformanceEventTiming).target as Element | null
        const scope = target?.closest?.('[data-perf-scope]')?.getAttribute('data-perf-scope') ?? 'global'
        pushCapped(
          perf.events,
          { name: e.name, startTime: e.startTime, duration: e.duration, scope },
          MAX_KEEP,
        )
      }
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit)
    perf.supported.event = true
  } catch {
    /* 浏览器不支持 event timing */
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const loaf = e as PerformanceEntry & { blockingDuration?: number }
        pushCapped(
          perf.loafs,
          { startTime: e.startTime, duration: e.duration, blocking: loaf.blockingDuration ?? 0 },
          MAX_KEEP,
        )
      }
    }).observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit)
    perf.supported.loaf = true
  } catch {
    /* 浏览器不支持 LoAF */
  }

  perf.supported.memory = typeof (performance as unknown as { memory?: unknown }).memory === 'object'
  if (perf.supported.memory) {
    const readHeap = () => {
      perf.heapMB =
        ((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize ?? 0) /
        1048576
    }
    readHeap()
    setInterval(readHeap, 1000)
  }

  startFrameMonitor()
}

/** rAF 差值法: 帧间隔 + 帧内 JS 估计(rAF 回调起点到紧随其后的微任务结束, 含 Vue flush) */
function startFrameMonitor() {
  let last = 0
  const loop = (t: number) => {
    const interval = last ? t - last : 0
    last = t
    const t0 = performance.now()
    queueMicrotask(() => {
      const js = performance.now() - t0
      if (interval > 0) pushCapped(perf.frames, { t, interval, js }, FRAME_KEEP)
    })
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)] ?? 0
}

export function p95(values: number[]): number {
  return percentile([...values].sort((a, b) => a - b), 95)
}

/** 页面级 INP 代理指标: 交互事件 duration 的 P95 (可限定场景作用域) */
export function interactionP95(scope?: string): number {
  const durations = perf.events
    .filter((e) => (e.name === 'click' || e.name === 'pointerdown' || e.name === 'keydown') && (!scope || e.scope === scope))
    .map((e) => e.duration)
  return p95(durations)
}

export function longTasksInWindow(start: number, end: number): LongTaskSample[] {
  // 重叠语义: 长任务可能跨窗口边界(如点击任务在 t0 前派发, 重活在窗口内执行)
  return perf.longTasks.filter((t) => t.startTime + t.duration > start && t.startTime < end)
}

export function framesInWindow(start: number, end: number): FrameSample[] {
  return perf.frames.filter((f) => f.t >= start && f.t <= end)
}

/** performance.mark/measure 薄封装, 统一前缀便于清理 */
export function mark(name: string) {
  performance.mark(name)
}

export function measure(name: string, startMark: string, endMark: string): number {
  const m = performance.measure(name, startMark, endMark)
  return m.duration
}

export function clearMarks() {
  performance.clearMarks()
  performance.clearMeasures()
}

/** 等待两帧(渲染完成) */
export function afterPaint(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve(performance.now()))
    })
  })
}
