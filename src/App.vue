<script setup lang="ts">
import { ref } from 'vue'
import ScenarioA from './scenarios/scenarioA/ScenarioA.vue'
import ScenarioB from './scenarios/scenarioB/ScenarioB.vue'
import ScenarioC from './scenarios/scenarioC/ScenarioC.vue'
import MemoTable from './scenarios/MemoTable.vue'
import PerfPanel from './components/PerfPanel.vue'

const tab = ref<'A' | 'B' | 'C' | 'T'>('A')
const tabs = [
  { key: 'A', label: '场景A 挂载任务' },
  { key: 'B', label: '场景B 交互扇出' },
  { key: 'C', label: '场景C 高频叠加' },
  { key: 'T', label: '表格 v-memo' },
] as const
</script>

<template>
  <div class="page">
    <h1>“几百个函数执行”性能优化对照实验</h1>
    <nav>
      <button v-for="t in tabs" :key="t.key" :class="{ active: tab === t.key }" @click="tab = t.key">
        {{ t.label }}
      </button>
    </nav>
    <main>
      <ScenarioA v-if="tab === 'A'" />
      <ScenarioB v-else-if="tab === 'B'" />
      <ScenarioC v-else-if="tab === 'C'" />
      <MemoTable v-else />
    </main>
    <PerfPanel />
  </div>
</template>

<style scoped>
.page {
  padding-bottom: 46vh;
}
nav {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
nav button.active {
  background: #42b883;
  color: #06281c;
}
h1 {
  font-size: 18px;
}
</style>
