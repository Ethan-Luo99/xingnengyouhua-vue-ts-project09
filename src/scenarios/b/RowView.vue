<script setup lang="ts">
import { onMounted, onUpdated } from 'vue'
import { countRowRender } from '../../perf/obs'
import type { Row } from './store'

/**
 * 表格行组件：渲染计数插桩（真实渲染次数，非估算）。
 * tick prop 是基线反模式：每次扇出都变化，强制全部 300 行重渲染。
 */
defineProps<{
  row: Row
  describe: (r: Row) => string
  tick?: number
}>()

onMounted(() => countRowRender())
onUpdated(() => countRowRender())
</script>

<template>
  <tr :data-row-id="row.id">
    <td>{{ row.id }}</td>
    <td>{{ row.name }}</td>
    <td>{{ row.category }}</td>
    <td class="num" data-col="value">{{ row.value }}</td>
    <td :data-status="row.status">{{ row.status }}</td>
    <td class="num">{{ row.score.toFixed(2) }}</td>
    <td class="num">{{ row.delta }}</td>
    <td>{{ describe(row) }}</td>
  </tr>
</template>
