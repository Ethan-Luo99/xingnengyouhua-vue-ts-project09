<script setup lang="ts">
/** 离屏统计面板: 仅展示, 高频 watcher 在父组件(可 pause/resume) */
defineProps<{
  stats: { tick: number; received: number; flushed: number; renders: number }
  consistent: boolean | null
  paused: boolean
}>()
</script>

<template>
  <div class="panel">
    <p>tick={{ stats.tick }} · received={{ stats.received }} · flushed={{ stats.flushed }} · renders={{ stats.renders }}</p>
    <p class="hint">
      watcher 状态: {{ paused ? '已暂停(pause)' : '运行中' }} · 恢复后一致性:
      <b :style="{ color: consistent === false ? '#e66' : '#6c6' }">{{ consistent === null ? '未验证' : consistent ? '✓ 一致' : '✗ 丢失依赖' }}</b>
    </p>
  </div>
</template>

<style scoped>
.panel {
  border: 1px dashed #555;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
}
.hint {
  color: #888;
  font-size: 12px;
}
</style>
