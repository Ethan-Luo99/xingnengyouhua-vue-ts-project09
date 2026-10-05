<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { flags, FLAG_KEYS, FLAG_LABELS, syncFlagsToUrl, allFlagsOn, allFlagsOff } from '../perf/flags'
import { obs, inpP95, heapMonitor, frameMonitor, startObservers } from '../perf/obs'
import { yieldStrategy } from '../perf/scheduler'
import { runStore, type ScenarioId } from '../perf/runController'
import { runSelfTests, type SelfTestResult } from '../perf/selftest'
import { aProbe } from '../scenarios/a/probe'

/**
 * 零依赖可观测性面板：
 * - PerformanceObserver: longtask / event(INP P95) / long-animation-frame
 * - 场景复跑结果表（基线 vs 当前开关，同口径）
 * - 边界自测（行为断言）
 */

const emit = defineEmits<{ rerun: [id: ScenarioId]; apply: [] }>()

startObservers()

function onToggleFlag(): void {
  syncFlagsToUrl()
}
function setAll(on: boolean): void {
  const target = on ? allFlagsOn() : allFlagsOff()
  for (const k of FLAG_KEYS) flags[k] = target[k]
  syncFlagsToUrl()
}

interface MetricDef {
  key: string
  label: string
  digits?: number
}

const SCENARIO_METRICS: Record<ScenarioId, MetricDef[]> = {
  a: [
    { key: 'windowMs', label: '挂载窗口总耗时 ms', digits: 1 },
    { key: 'execMs', label: '任务执行段耗时 ms', digits: 1 },
    { key: 'longtasks', label: '>50ms Long Task 数' },
    { key: 'longtaskTotalMs', label: 'Long Task 总时长 ms', digits: 1 },
    { key: 'tasks', label: '注册任务完成数' },
    { key: 'residualListeners', label: '卸载后残留监听器触发' },
    { key: 'residualWatchers', label: '卸载后残留 watcher 触发' },
    { key: 'residualIntervals', label: '卸载后残留定时器触发' },
  ],
  b: [
    { key: 'handlerMs', label: 'handler 同步段 ms', digits: 1 },
    { key: 'longtasks', label: '>50ms Long Task 数' },
    { key: 'computedRecalcs', label: '派生重算次数' },
    { key: 'watchTriggers', label: 'watcher 触发次数' },
    { key: 'rowRenders', label: '行组件渲染次数' },
    { key: 'staleMismatches', label: 'stale UI 不一致数' },
    { key: 'memoHits', label: 'LRU 命中' },
    { key: 'memoMisses', label: 'LRU 未命中' },
  ],
  c: [
    { key: 'frames', label: '采样帧数' },
    { key: 'droppedFrames', label: '掉帧数' },
    { key: 'dropRatePct', label: '掉帧率 %', digits: 1 },
    { key: 'frameJsAvgMs', label: '每帧 JS 均值 ms', digits: 2 },
    { key: 'frameJsP95Ms', label: '每帧 JS P95 ms', digits: 2 },
    { key: 'flushes', label: 'flush 轮次' },
    { key: 'renders', label: '列表渲染次数' },
    { key: 'longtasks', label: '>50ms Long Task 数' },
    { key: 'droppedMsgs', label: '背压丢弃消息数' },
  ],
}

const SCENARIO_NAMES: Record<ScenarioId, string> = {
  a: '场景A 挂载',
  b: '场景B 扇出',
  c: '场景C 高频流',
}

function fmt(v: number | undefined, digits = 0): string {
  if (v === undefined || Number.isNaN(v)) return '—'
  return v.toFixed(digits)
}

const selfTests = ref<SelfTestResult[]>([])
const testing = ref(false)
async function runTests(): Promise<void> {
  testing.value = true
  try {
    selfTests.value = await runSelfTests()
  } finally {
    testing.value = false
  }
}

onMounted(() => {
  if (new URLSearchParams(location.search).get('selftest') === '1') void runTests()
})
</script>

<template>
  <aside class="panel">
    <h2>可观测性面板（零依赖）</h2>

    <section>
      <h3>优化手段开关（URL 参数同名，如 ?memo=0）</h3>
      <div class="flags">
        <label v-for="k in FLAG_KEYS" :key="k">
          <input type="checkbox" v-model="flags[k]" @change="onToggleFlag" />
          {{ FLAG_LABELS[k] }}
        </label>
      </div>
      <div class="btn-row">
        <button @click="setAll(false)">全关（基线）</button>
        <button @click="setAll(true)">全开（优化）</button>
        <button @click="emit('apply')">应用并重新挂载场景</button>
      </div>
    </section>

    <section>
      <h3>实时指标（PerformanceObserver）</h3>
      <table>
        <tbody>
          <tr><td>Long Task 总数（&gt;50ms）</td><td>{{ obs.longtasks.length }}</td></tr>
          <tr><td>INP P95（真实点击，{{ obs.events.length }} 次交互）</td><td>{{ inpP95(obs.events).toFixed(0) }}ms</td></tr>
          <tr><td>Long Animation Frame 数</td><td>{{ obs.loafs.length }}</td></tr>
          <tr>
            <td>堆内存斜率（Chrome，需运行 60s）</td>
            <td>
              {{ heapMonitor.supported ? (heapMonitor.slopeBytesPerSec / 1024).toFixed(1) + ' KB/s' : '不支持 performance.memory' }}
            </td>
          </tr>
          <tr><td>帧监控</td><td>{{ frameMonitor.running ? '运行中' : `停止（${frameMonitor.frames} 帧）` }}</td></tr>
          <tr><td>scheduler.yield 让出链</td><td>{{ yieldStrategy }}</td></tr>
          <tr v-if="obs.observerErrors.length > 0"><td>observer 降级</td><td>{{ obs.observerErrors.join('; ') }}</td></tr>
        </tbody>
      </table>
    </section>

    <section v-for="id in (['a', 'b', 'c'] as ScenarioId[])" :key="id">
      <h3>
        {{ SCENARIO_NAMES[id] }}
        <button :disabled="runStore.status !== 'idle'" @click="emit('rerun', id)">一键复跑对比</button>
      </h3>
      <table>
        <thead>
          <tr><th>指标</th><th>基线（全关）</th><th>当前开关</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in SCENARIO_METRICS[id]" :key="m.key">
            <td>{{ m.label }}</td>
            <td>{{ fmt(runStore.results[id].baseline?.[m.key], m.digits) }}</td>
            <td>{{ fmt(runStore.results[id].current?.[m.key], m.digits) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h3>场景A 残留探针（卸载后行为断言）</h3>
      <p v-if="!aProbe.ran">尚未卸载过场景A（切换标签页或复跑后出结果）</p>
      <table v-else>
        <tbody>
          <tr><td>卸载后监听器仍触发</td><td>{{ aProbe.listenerFires }}</td></tr>
          <tr><td>卸载后 watcher 仍触发</td><td>{{ aProbe.watcherFires }}</td></tr>
          <tr><td>卸载后定时器仍触发</td><td>{{ aProbe.intervalTicks }}</td></tr>
        </tbody>
      </table>
    </section>

    <section>
      <h3>
        边界自测（行为断言）
        <button :disabled="testing" @click="runTests">{{ testing ? '运行中…' : '运行自测' }}</button>
      </h3>
      <table v-if="selfTests.length > 0">
        <tbody>
          <tr v-for="t in selfTests" :key="t.name">
            <td>{{ t.pass ? '✅' : '❌' }} {{ t.name }}</td>
            <td class="detail">{{ t.detail }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else>覆盖：shallowRef/triggerRef、pause/resume、LRU、分片调度器、背压策略。</p>
    </section>
  </aside>
</template>
