<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { flagOverride, allFlagsOff, type PerfFlags } from './perf/flags'
import {
  runStore,
  expectRun,
  expectProbe,
  type RunMetrics,
  type ScenarioId,
} from './perf/runController'
import ScenarioA from './scenarios/a/ScenarioA.vue'
import ScenarioB from './scenarios/b/ScenarioB.vue'
import ScenarioC from './scenarios/c/ScenarioC.vue'
import PerfPanel from './components/PerfPanel.vue'

const initialTab = new URLSearchParams(location.search).get('tab')
const activeTab = ref<ScenarioId>(
  initialTab === 'b' || initialTab === 'c' ? initialTab : 'a',
)
const scenarioKey = ref(0)
const scenarioMounted = ref(true)

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('run timeout')), ms)
    }),
  ])
}

async function runOnce(id: ScenarioId, override: PerfFlags | null): Promise<RunMetrics> {
  flagOverride.value = override
  runStore.pending = id
  activeTab.value = id
  scenarioMounted.value = true
  scenarioKey.value++
  return await withTimeout(expectRun(), 15000)
}

/** 一键复跑：同页面内先全关（基线）再按当前开关各跑一遍，同口径采集 */
async function rerun(id: ScenarioId): Promise<void> {
  if (runStore.status !== 'idle') return
  try {
    runStore.status = 'running-baseline'
    const base = await runOnce(id, allFlagsOff())
    if (id === 'a') {
      const probe = expectProbe()
      scenarioMounted.value = false
      Object.assign(base, await withTimeout(probe, 5000))
      await new Promise((r) => setTimeout(r, 60))
    }
    runStore.results[id].baseline = base

    runStore.status = 'running-current'
    const cur = await runOnce(id, null)
    if (id === 'a') {
      const probe = expectProbe()
      scenarioMounted.value = false
      Object.assign(cur, await withTimeout(probe, 5000))
      await new Promise((r) => setTimeout(r, 60))
    }
    runStore.results[id].current = cur
  } finally {
    runStore.pending = null
    runStore.status = 'idle'
    scenarioMounted.value = true
    scenarioKey.value++
  }
}

function applyFlags(): void {
  flagOverride.value = null
  scenarioKey.value++
}

function selectTab(id: ScenarioId): void {
  runStore.pending = null
  activeTab.value = id
}

onMounted(() => {
  const r = new URLSearchParams(location.search).get('rerun')
  if (r === 'a' || r === 'b' || r === 'c') void rerun(r)
})
</script>

<template>
  <div class="layout">
    <header>
      <h1>Vue 3.5 性能手段演示台</h1>
      <nav>
        <button :class="{ active: activeTab === 'a' }" @click="selectTab('a')">场景A 挂载</button>
        <button :class="{ active: activeTab === 'b' }" @click="selectTab('b')">场景B 扇出</button>
        <button :class="{ active: activeTab === 'c' }" @click="selectTab('c')">场景C 高频流</button>
      </nav>
      <span class="run-status" v-if="runStore.status !== 'idle'">复跑中：{{ runStore.status }}</span>
    </header>
    <main>
      <ScenarioA v-if="activeTab === 'a' && scenarioMounted" :key="'a' + scenarioKey" />
      <ScenarioB v-else-if="activeTab === 'b' && scenarioMounted" :key="'b' + scenarioKey" />
      <ScenarioC v-else-if="activeTab === 'c' && scenarioMounted" :key="'c' + scenarioKey" />
    </main>
    <PerfPanel @rerun="rerun" @apply="applyFlags" />
  </div>
</template>
