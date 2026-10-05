<script setup lang="ts">
import { ref, reactive, watch, triggerRef, shallowRef, onMounted, onUnmounted, nextTick, type WatchHandle } from 'vue'
import { flags, withFlags } from '../../perf/flags'
import { count, counters, perf, resetCounters, longTasksInWindow, framesInWindow, afterPaint, p95 } from '../../perf/metrics'
import { createStreamBatcher, type DropPolicy } from '../../perf/streamBatcher'
import { registerBenchmark, unregisterBenchmark } from '../../perf/bench'
import AnimBox from './AnimBox.vue'
import OffscreenPanel from './OffscreenPanel.vue'

/**
 * 场景 C: 定时器 + rAF + 模拟流式推送(每帧 50 条)三高频来源叠加
 * 基线: 每条消息独立宏任务(MessageChannel) -> 每条一轮 flush; 深响应式数组
 * 优化: C2 流聚批+背压(每帧至多一次 flush) + C1 shallowRef 就地改+triggerRef(每帧一次) + C3 离屏 watcher pause/resume
 */

interface Msg {
  seq: number
  ts: number
  payload: string
}

const VIEW_CAP = 200
const MSG_PER_TICK = 50
const BASELINE_BACKLOG_CAP = 400

// ---- 数据存储: 基线深响应式 vs 优化 shallowRef 就地改+triggerRef ----
const baseList = reactive<Msg[]>([])
const optList = shallowRef<Msg[]>([])
// 注意: 不能用 computed 透传 —— triggerRef 后 computed 重算得到同一数组引用,
// hasChanged=false 会吞掉下游通知(静默不更新)。渲染期直接读, 让渲染副作用直接依赖 optList
function visibleList(): Msg[] {
  return flags.shallow ? optList.value : baseList
}

const streamStats = reactive({ received: 0, dropped: 0, flushed: 0 })
const timerTick = ref(0)

// ---- 流聚批 + 背压 ----
const batcherOpts = reactive({ capacity: 500, policy: 'drop-oldest' as DropPolicy, expireMs: 100 })
const batcher = createStreamBatcher<Msg>({
  get capacity() {
    return batcherOpts.capacity
  },
  get policy() {
    return batcherOpts.policy
  },
  get expireMs() {
    return batcherOpts.expireMs
  },
  flush: flushBatch,
} as unknown as Parameters<typeof createStreamBatcher<Msg>>[0])

function writeOne(m: Msg) {
  if (flags.shallow) {
    const arr = optList.value
    arr.push(m)
    if (arr.length > VIEW_CAP) arr.shift()
    triggerRef(optList)
    count('C triggerRef 次数')
  } else {
    baseList.push(m)
    if (baseList.length > VIEW_CAP) baseList.shift()
  }
}

function flushBatch(batch: Msg[]) {
  if (flags.shallow) {
    const arr = optList.value
    for (const m of batch) arr.push(m)
    while (arr.length > VIEW_CAP) arr.shift()
    triggerRef(optList)
    count('C triggerRef 次数')
  } else {
    for (const m of batch) {
      baseList.push(m)
      if (baseList.length > VIEW_CAP) baseList.shift()
    }
  }
  streamStats.flushed += batch.length
}

// ---- 三种高频来源 ----
let seq = 0
let timerId = 0
let streamId = 0
let msgChan: MessageChannel | null = null
let produced = 0
let consumed = 0
const running = ref(false)

function makeMsg(): Msg {
  seq++
  return { seq, ts: performance.now(), payload: Math.random().toString(36).repeat(8).slice(0, 120) }
}

function deliverBaseline(m: Msg) {
  // 每条消息独立宏任务(模拟 WebSocket onmessage), 每条引发一轮 flush
  if (produced - consumed > BASELINE_BACKLOG_CAP) {
    count('C 源侧丢弃')
    streamStats.dropped++
    return
  }
  produced++
  msgChan!.port2.postMessage(m)
}

function startSources() {
  if (running.value) return
  running.value = true
  msgChan = new MessageChannel()
  msgChan.port1.onmessage = (e) => {
    consumed++
    writeOne(e.data as Msg)
  }
  timerId = window.setInterval(() => {
    timerTick.value++
    count('C 定时器写入')
  }, 16)
  streamId = window.setInterval(() => {
    for (let k = 0; k < MSG_PER_TICK; k++) {
      const m = makeMsg()
      count('C 收到消息')
      streamStats.received++
      if (flags.batch) {
        if (!batcher.push(m)) {
          count('C 背压丢弃')
          streamStats.dropped++
        }
      } else {
        deliverBaseline(m)
      }
    }
  }, 16)
  batcher.start()
}

function stopSources() {
  running.value = false
  clearInterval(timerId)
  clearInterval(streamId)
  batcher.stop()
  msgChan?.port1.close()
  msgChan?.port2.close()
  msgChan = null
}

function clearLists() {
  baseList.splice(0)
  optList.value = []
  streamStats.received = 0
  streamStats.dropped = 0
  streamStats.flushed = 0
  Object.assign(batcher.stats, { received: 0, accepted: 0, dropped: 0, expired: 0, flushes: 0, flushedMsgs: 0 })
}

// ---- C3: 离屏 watcher pause/resume ----
const panelVisible = ref(true)
const paused = ref(false)
const consistent = ref<boolean | null>(null)
const offscreen = reactive({ tick: 0, received: 0, flushed: 0, renders: 0 })
const watchHandles: WatchHandle[] = []
for (let i = 0; i < 5; i++) {
  watchHandles.push(
    watch(
      [timerTick, () => streamStats.received, () => streamStats.flushed, () => counters['C 列表渲染次数'] ?? 0],
      () => {
        count('C 离屏 watcher 触发')
        offscreen.tick = timerTick.value
        offscreen.received = streamStats.received
        offscreen.flushed = streamStats.flushed
        offscreen.renders = counters['C 列表渲染次数'] ?? 0
      },
      { immediate: true },
    ),
  )
}

function applyPause() {
  if (!flags.pause) {
    if (paused.value) {
      for (const h of watchHandles) h.resume()
      paused.value = false
    }
    return
  }
  const shouldRun = panelVisible.value && document.visibilityState === 'visible'
  if (!shouldRun && !paused.value) {
    for (const h of watchHandles) h.pause()
    paused.value = true
  } else if (shouldRun && paused.value) {
    for (const h of watchHandles) h.resume()
    paused.value = false
    // 恢复后验证依赖未丢: watcher 应补算到最新值
    void nextTick(() => {
      consistent.value = offscreen.tick === timerTick.value && offscreen.received === streamStats.received
    })
  }
}
watch([panelVisible, () => flags.pause], applyPause)
document.addEventListener('visibilitychange', applyPause)

// ---- C1 边界用例: 证明没有漏 trigger 导致的静默不更新 ----
const edgeResults = ref<{ name: string; pass: boolean; detail: string }[]>([])
const listEl = ref<HTMLElement | null>(null)

async function edgeChecks() {
  const wasRunning = running.value
  stopSources()
  edgeResults.value = []
  await withFlags({ shallow: true, batch: true }, async () => {
    clearLists()
    await nextTick()
    // 用例1: 漏 triggerRef 必然静默不更新(负向对照), 补上 triggerRef 后恢复
    {
      const m = makeMsg()
      optList.value.push(m) // 故意不 triggerRef
      await nextTick()
      const stale = !listEl.value?.querySelector(`[data-seq="${m.seq}"]`)
      triggerRef(optList)
      await nextTick()
      const recovered = !!listEl.value?.querySelector(`[data-seq="${m.seq}"]`)
      edgeResults.value.push({
        name: '用例1 漏trigger可检测且可恢复',
        pass: stale && recovered,
        detail: `未trigger时DOM缺失=${stale}, 补trigger后上屏=${recovered}`,
      })
    }
    // 用例2: 帧边界写入不丢 — 经 batcher 推 7 条, 下一帧全部上屏
    {
      const before = seq
      for (let k = 0; k < 7; k++) batcher.push(makeMsg())
      batcher.start()
      await afterPaint()
      await nextTick()
      const lastDomSeq = Number(listEl.value?.lastElementChild?.getAttribute('data-seq') ?? 0)
      edgeResults.value.push({
        name: '用例2 帧边界写入全部上屏',
        pass: lastDomSeq === seq && seq === before + 7,
        detail: `期望末条 seq=${seq}, DOM 末条 seq=${lastDomSeq}`,
      })
      batcher.stop()
    }
    // 用例3: 计数不变量 — received = flushed + dropped + expired + buffered
    {
      const s = batcher.stats
      const balanced = s.accepted === s.flushedMsgs + s.expired + batcher.buffered
      const domCount = listEl.value?.children.length ?? -1
      const viewOk = domCount === optList.value.length
      edgeResults.value.push({
        name: '用例3 聚批计数不变量+视图一致',
        pass: balanced && viewOk,
        detail: `accepted=${s.accepted} flushed=${s.flushedMsgs} expired=${s.expired} buffered=${batcher.buffered} · DOM=${domCount} view=${optList.value.length}`,
      })
    }
    clearLists()
  })
  if (wasRunning) startSources()
}

// ---- 基准: 稳态运行 N 秒, 采集帧指标 ----
const benchRunning = ref(false)
const memResult = ref('')

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function runBench(mode: 'baseline' | 'optimized', durationMs: number) {
  benchRunning.value = true
  const patch =
    mode === 'optimized' ? { shallow: true, batch: true, pause: true } : { shallow: false, batch: false, pause: false }
  return withFlags(patch, async () => {
    resetCounters('C ')
    clearLists()
    const heapSeries: number[] = []
    const t0 = performance.now()
    startSources()
    const heapTimer = window.setInterval(() => heapSeries.push(perf.heapMB), 1000)
    await sleep(durationMs)
    stopSources()
    clearInterval(heapTimer)
    await afterPaint()
    benchRunning.value = false
    const t1 = performance.now()
    const frames = framesInWindow(t0, t1)
    const droppedFrames = frames.filter((f) => f.interval > 26.8).length
    const lts = longTasksInWindow(t0, t1)
    return {
      '帧JS P95(ms)': +p95(frames.map((f) => f.js)).toFixed(2),
      '丢帧率%': +((droppedFrames / Math.max(1, frames.length)) * 100).toFixed(1),
      '长任务数': lts.length,
      '列表渲染次数': counters['C 列表渲染次数'] ?? 0,
      'triggerRef次数': counters['C triggerRef 次数'] ?? 0,
      '收到消息': counters['C 收到消息'] ?? 0,
      '丢弃消息': (counters['C 源侧丢弃'] ?? 0) + (counters['C 背压丢弃'] ?? 0) + batcher.stats.expired,
      '堆增量(MB)': heapSeries.length > 1 ? +(heapSeries[heapSeries.length - 1]! - heapSeries[0]!).toFixed(1) : 0,
    }
  })
}

async function memoryRun60s() {
  memResult.value = '运行中(60s)...'
  const snap = await withFlags({ shallow: true, batch: true, pause: true }, async () => {
    clearLists()
    const heapSeries: number[] = []
    startSources()
    const t = window.setInterval(() => heapSeries.push(perf.heapMB), 1000)
    await sleep(60000)
    stopSources()
    clearInterval(t)
    return heapSeries
  })
  const firstMin = Math.min(...snap.slice(0, 6))
  const lastMin = Math.min(...snap.slice(-6))
  const growth = firstMin > 0 ? ((lastMin - firstMin) / firstMin) * 100 : 0
  memResult.value = `60s 堆采样: 前段谷底 ${firstMin.toFixed(1)}MB → 末段谷底 ${lastMin.toFixed(1)}MB, 增长 ${growth.toFixed(1)}% ${growth < 10 ? '✓ 非单调增长' : '✗ 疑似泄漏'}`
}

onMounted(() => {
  registerBenchmark('C', async () => {
    const baseline = await runBench('baseline', 8000)
    const optimized = await runBench('optimized', 8000)
    return { baseline, optimized, note: '各运行 8s 稳态采样; 内存 60s 验证请用下方专用按钮' }
  })
})

onUnmounted(() => {
  unregisterBenchmark('C')
  stopSources()
  for (const h of watchHandles) h.stop()
  document.removeEventListener('visibilitychange', applyPause)
})

function trackRender() {
  count('C 列表渲染次数')
  return ''
}
</script>

<template>
  <section data-perf-scope="C">
    <h2>场景 C · 定时器 + rAF + 流式推送(每帧 {{ MSG_PER_TICK }} 条)叠加</h2>
    <p class="desc">
      基线: 每条消息独立宏任务触发一轮 flush, 深响应式数组。优化: C2 聚批+背压(每帧≤1次 flush) + C1 shallowRef 就地改+triggerRef + C3 离屏 watcher 暂停。
    </p>
    <div class="ops">
      <button @click="running ? stopSources() : startSources()">{{ running ? '停止' : '启动' }}三源</button>
      <button @click="edgeChecks">运行 C1 边界用例</button>
      <button @click="memoryRun60s" :disabled="benchRunning">60s 内存验证</button>
      <label>容量 <input type="number" v-model.number="batcherOpts.capacity" style="width: 64px" /></label>
      <label>
        丢弃策略
        <select v-model="batcherOpts.policy">
          <option value="none">none(拒收)</option>
          <option value="drop-oldest">drop-oldest</option>
          <option value="drop-newest">drop-newest</option>
          <option value="expire">expire(100ms)</option>
        </select>
      </label>
    </div>
    <div class="row2">
      <AnimBox />
      <div class="stats">
        received={{ streamStats.received }} · dropped={{ streamStats.dropped }} · flushed={{ streamStats.flushed }} ·
        缓冲={{ batcher.buffered }}
      </div>
    </div>
    <div class="ops">
      <label><input type="checkbox" v-model="panelVisible" /> 离屏统计面板可见</label>
      <span class="hint">(隐藏时 C3 应暂停 watcher; 恢复后一致性自动验证)</span>
    </div>
    <OffscreenPanel v-show="panelVisible" :stats="offscreen" :consistent="consistent" :paused="paused" />
    <div ref="listEl" class="stream">
      <div class="msg" v-for="m in visibleList()" :key="m.seq" :data-seq="m.seq">#{{ m.seq }} {{ m.payload.slice(0, 48) }}</div>
    </div>
    <span style="display: none">{{ trackRender() }}</span>
    <div v-if="edgeResults.length" class="edge">
      <p v-for="r in edgeResults" :key="r.name" :style="{ color: r.pass ? '#6c6' : '#e66' }">
        {{ r.pass ? '✓' : '✗' }} {{ r.name }} — {{ r.detail }}
      </p>
    </div>
    <p v-if="memResult" class="hint">{{ memResult }}</p>
  </section>
</template>

<style scoped>
section {
  margin-bottom: 24px;
}
.desc {
  color: #999;
  font-size: 13px;
}
.ops {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin: 6px 0;
  font-size: 13px;
}
.row2 {
  display: flex;
  gap: 16px;
  align-items: center;
  margin: 6px 0;
}
.stats {
  font-size: 12px;
  color: #aaa;
}
.stream {
  height: 180px;
  overflow: auto;
  border: 1px solid #333;
  border-radius: 4px;
  margin-top: 8px;
  font-size: 11px;
  font-family: monospace;
}
.msg {
  padding: 1px 6px;
  border-bottom: 1px solid #222;
  white-space: nowrap;
}
.edge {
  margin-top: 8px;
  font-size: 12px;
}
.hint {
  color: #888;
  font-size: 12px;
}
</style>
