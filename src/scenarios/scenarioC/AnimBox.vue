<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

/** 自包含 rAF 动画源: 每帧写自身状态, 不污染父组件渲染计数 */
const x = ref(0)
let rafId = 0
let running = false

function loop() {
  x.value = (x.value + 2) % 300
  rafId = requestAnimationFrame(loop)
}

function start() {
  if (running) return
  running = true
  rafId = requestAnimationFrame(loop)
}
function stop() {
  running = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
}

onMounted(start)
onUnmounted(stop)
</script>

<template>
  <div class="track">
    <div class="box" :style="{ transform: `translateX(${x}px)` }"></div>
  </div>
</template>

<style scoped>
.track {
  width: 340px;
  height: 24px;
  border: 1px solid #444;
  border-radius: 4px;
  overflow: hidden;
}
.box {
  width: 24px;
  height: 22px;
  background: #42b883;
  border-radius: 3px;
  will-change: transform;
}
</style>
