<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { FLAG_DEFS, flags, setAll } from '../perf/flags'
import { perf, counters, resetCounters, interactionP95, p95 } from '../perf/metrics'
import { benchStates, runCompare, fmt } from '../perf/bench'
import { yieldMode } from '../perf/scheduler'

const open = ref(true)
const tick = ref(0)
let timer = 0
onMounted(() => {
  timer = window.setInterval(() => tick.value++, 1000)
})
onUnmounted(() => clearInterval(timer))

const SCENARIOS = ['A', 'B', 'C', 'T'] as const
const SCENE_NAMES: Record<string, string> = {
  A: '场景A 挂载任务',
  B: '场景B 交互扇出',
  C: '场景C 高频叠加',
  T: '表格 v-memo',
}

const DEFAULT_KEYS: Record<string, string[]> = {
  A: ['首屏长任务数(>50ms)', '挂载同步段(ms)', '全部任务完成(ms)', '卸载后残留副作用', '卸载后定时器仍跳动'],
  B: ['交互总时长(ms)', '长任务数(>50ms)', 'watcher 触发次数', '派生计算次数', '渲染组件数', '纯函数调用', '记忆化命中', '强制布局次数'],
  C: ['帧JS P95(ms)', '丢帧率%', '长任务数', '列表渲染次数', 'triggerRef次数', '收到消息', '丢弃消息', '堆增量(MB)'],
  T: ['变更行数', 'patch耗时(ms)', '单元渲染次数', 'stale行数'],
}

function metricKeys(name: string): string[] {
  const st = benchStates[name]
  const keys = new Set<string>(DEFAULT_KEYS[name] ?? [])
  for (const k of Object.keys(st?.baseline ?? {})) keys.add(k)
  for (const k of Object.keys(st?.optimized ?? {})) keys.add(k)
  return [...keys]
}

const live = computed(() => {
  void tick.value
  const frames = perf.frames.slice(-120)
  const intervals = frames.map((f) => f.interval)
  const js = frames.map((f) => f.js)
  const dropped = frames.filter((f) => f.interval > 26.8).length
  const lt = perf.longTasks
  return {
    longTasks: lt.length,
    maxLongTask: lt.length ? Math.max(...lt.map((t) => t.duration)) : 0,
    inpAll: interactionP95(),
    inpB: interactionP95('B'),
    loafs: perf.loafs.length,
    avgInterval: intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0,
    jsP95: p95(js),
    droppedPct: frames.length ? (dropped / frames.length) * 100 : 0,
    heap: perf.heapMB,
  }
})

const counterEntries = computed(() => {
  void tick.value
  return Object.entries(counters).sort(([a], [b]) => a.localeCompare(b))
})

const benchErr = ref('')
async function rerun(name: string) {
  benchErr.value = ''
  try {
    await runCompare(name)
  } catch (e) {
    benchErr.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <div class="panel" :class="{ closed: !open }">
    <div class="bar" @click="open = !open">
      <b>可观测性面板</b>
      <span class="dim">
        长任务 {{ live.longTasks }}(max {{ live.maxLongTask.toFixed(0) }}ms) · INP P95 {{ live.inpAll.toFixed(0) }}ms(B场景
        {{ live.inpB.toFixed(0) }}ms) · LoAF {{ live.loafs }} · 帧JS P95 {{ live.jsP95.toFixed(1) }}ms · 丢帧
        {{ live.droppedPct.toFixed(0) }}% · 堆 {{ live.heap.toFixed(0) }}MB
      </span>
      <span>{{ open ? '▾ 收起' : '▴ 展开' }}</span>
    </div>
    <div v-show="open" class="body">
      <div class="col">
        <h3>优化开关(独立启停, 同步 URL ?flags=)</h3>
        <label v-for="d in FLAG_DEFS" :key="d.key" class="flag">
          <input type="checkbox" v-model="flags[d.key]" /> {{ d.label }}
        </label>
        <div class="btnrow">
          <button @click="setAll(true)">全开</button>
          <button @click="setAll(false)">全关(基线)</button>
        </div>
        <h3>采集能力</h3>
        <p class="dim">
          longtask={{ perf.supported.longtask ? '✓' : '✗' }} event={{ perf.supported.event ? '✓' : '✗' }} LoAF={{
            perf.supported.loaf ? '✓' : '✗'
          }}
          memory={{ perf.supported.memory ? '✓' : '✗' }} · 让出原语: {{ yieldMode }}
        </p>
        <h3>实时指标</h3>
        <table>
          <tbody>
            <tr><td>长任务总数 / 最大</td><td>{{ live.longTasks }} / {{ live.maxLongTask.toFixed(0) }}ms</td></tr>
            <tr><td>INP P95(全部 / B场景)</td><td>{{ live.inpAll.toFixed(0) }} / {{ live.inpB.toFixed(0) }}ms</td></tr>
            <tr><td>LoAF 数</td><td>{{ live.loafs }}</td></tr>
            <tr><td>帧间隔均值(近120帧)</td><td>{{ live.avgInterval.toFixed(1) }}ms</td></tr>
            <tr><td>帧JS P95(rAF差值法)</td><td>{{ live.jsP95.toFixed(2) }}ms</td></tr>
            <tr><td>丢帧率(近120帧)</td><td>{{ live.droppedPct.toFixed(1) }}%</td></tr>
            <tr><td>JS 堆</td><td>{{ live.heap.toFixed(1) }}MB</td></tr>
          </tbody>
        </table>
      </div>
      <div class="col">
        <h3>计数器 <button class="mini" @click="resetCounters()">清零</button></h3>
        <table class="counters">
          <tbody>
            <tr v-for="[k, v] in counterEntries" :key="k">
              <td>{{ k }}</td>
              <td>{{ v }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="col wide">
        <h3>优化前/后对比(同口径, 一键复跑)</h3>
        <p v-if="benchErr" class="err">{{ benchErr }}</p>
        <div v-for="name in SCENARIOS" :key="name" class="bench">
          <div class="bench-head">
            <b>{{ SCENE_NAMES[name] }}</b>
            <button class="mini" :disabled="benchStates[name]?.running" @click="rerun(name)">
              {{ benchStates[name]?.running ? '运行中…' : '复跑对比' }}
            </button>
          </div>
          <table>
            <thead>
              <tr><th>指标</th><th>基线(全关)</th><th>优化(全开)</th></tr>
            </thead>
            <tbody>
              <tr v-for="k in metricKeys(name)" :key="k">
                <td>{{ k }}</td>
                <td>{{ fmt(benchStates[name]?.baseline?.[k]) }}</td>
                <td>{{ fmt(benchStates[name]?.optimized?.[k]) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="benchStates[name]?.note" class="dim">{{ benchStates[name]?.note }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background: #14161a;
  border-top: 1px solid #333;
  z-index: 100;
  font-size: 12px;
}
.bar {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 6px 12px;
  cursor: pointer;
  background: #1c1f26;
}
.body {
  display: flex;
  gap: 20px;
  padding: 10px 14px;
  max-height: 42vh;
  overflow: auto;
}
.col {
  min-width: 240px;
  flex: 1;
}
.col.wide {
  flex: 2;
}
h3 {
  font-size: 12px;
  margin: 8px 0 4px;
  color: #8ab4f8;
}
.flag {
  display: block;
  padding: 1px 0;
}
.btnrow {
  display: flex;
  gap: 6px;
  margin: 6px 0;
}
table {
  border-collapse: collapse;
  width: 100%;
}
td,
th {
  border: 1px solid #2c2f36;
  padding: 2px 6px;
  text-align: left;
  white-space: nowrap;
}
.counters {
  font-family: monospace;
}
.dim {
  color: #777;
}
.err {
  color: #e66;
}
.bench {
  margin-bottom: 10px;
}
.bench-head {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 4px 0;
}
.mini {
  font-size: 11px;
  padding: 1px 8px;
}
</style>
