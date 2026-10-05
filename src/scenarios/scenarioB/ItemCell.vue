<script setup lang="ts">
import { computed, onBeforeUpdate, onMounted } from 'vue'
import { count } from '../../perf/metrics'

const props = defineProps<{
  id: number
  val: number
  /** 基线模式的粗粒度依赖: 每次点击都变, 导致全部单元重渲染 */
  epoch?: number
}>()

onMounted(() => count('B 单元挂载数'))
onBeforeUpdate(() => count('B 渲染组件数'))

const display = computed(() => {
  // 故意读取 epoch(若传入)以建立粗粒度依赖
  void props.epoch
  return props.val.toFixed(0)
})
</script>

<template>
  <div class="cell">#{{ id }} {{ display }}</div>
</template>

<style scoped>
.cell {
  font-size: 11px;
  padding: 2px 4px;
  border: 1px solid #333;
  border-radius: 3px;
  white-space: nowrap;
}
</style>
