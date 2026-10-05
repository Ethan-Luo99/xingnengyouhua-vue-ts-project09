<script setup lang="ts">
import { onMounted, onUpdated } from 'vue'
import { countRender } from '../../perf/obs'
import type { StreamMsg } from './sources'

/**
 * 接收 ref 而非数组值：渲染效应直接订阅 shallowRef，
 * 这样 triggerRef 才能穿透组件边界驱动重渲染。
 * （若传数组值，就地改 + triggerRef 会被 props 浅比较吞掉 → 静默不更新）
 */
defineProps<{ listRef: { value: StreamMsg[] } }>()

onMounted(() => countRender())
onUpdated(() => countRender())
</script>

<template>
  <ul class="msg-list">
    <li v-for="m in listRef.value" :key="m.seq">
      <span class="seq">#{{ m.seq }}</span>
      <span class="src" :data-src="m.source">{{ m.source }}</span>
      <span class="num">{{ m.payload }}</span>
    </li>
  </ul>
</template>
