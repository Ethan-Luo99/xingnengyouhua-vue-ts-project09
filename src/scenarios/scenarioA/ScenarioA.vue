<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue'
import { flags, withFlags } from '../../perf/flags'
import { longTasksInWindow, resetCounters, afterPaint } from '../../perf/metrics'
import { registerBenchmark, unregisterBenchmark } from '../../perf/bench'
import ScenarioARunner from './ScenarioARunner.vue'
import { residue, residueTotal, forceCleanupBaseline, currentScheduler, runState } from './tasks'

const mountKey = ref(0)
const mounted = ref(false)
const lastInfo = ref('尚未运行')

async function runOnce(mode: 'baseline' | 'optimized') {
  const patch = mode === 'optimized' ? { scope: true, chunk: true } : { scope: false, chunk: false }
  return withFlags(patch, async () => {
    resetCounters('A ')
    residue.leakedTicks = 0
    const t0 = performance.now()
    mounted.value = false
    await nextTick()
    mountKey.value++
    mounted.value = true
    await nextTick() // setup 同步段(含基线全部任务 / 优化 critical 任务)完成
    const tMount = performance.now()
    // 等待分片队列清空 + 一帧绘制
    await currentScheduler?.whenIdle()
    await afterPaint()
    const tEnd = performance.now()
    const longTasks = longTasksInWindow(t0 - 1, tEnd + 1)
    // 卸载, 观察残留
    mounted.value = false
    await nextTick()
    const leakedAfterUnmount = residueTotal()
    const ticksAtUnmount = residue.leakedTicks
    await new Promise((r) => setTimeout(r, 600)) // 等泄漏探针跳动窗口
    const leakedTicksGrew = residue.leakedTicks > ticksAtUnmount
    if (mode === 'baseline') forceCleanupBaseline() // 测试卫生: 清理基线泄漏, 避免污染后续测量
    return {
      '首屏长任务数(>50ms)': longTasks.length,
      '挂载同步段(ms)': +(tMount - t0).toFixed(1),
      '全部任务完成(ms)': +(tEnd - t0).toFixed(1),
      '卸载后残留副作用': leakedAfterUnmount,
      '卸载后定时器仍跳动': leakedTicksGrew ? '是(泄漏)' : '否',
    }
  })
}

onMounted(() => {
  registerBenchmark('A', async () => {
    const baseline = await runOnce('baseline')
    const optimized = await runOnce('optimized')
    lastInfo.value = '对比完成'
    return { baseline, optimized, note: '长任务窗口含挂载+分片全程; 残留=卸载后仍存活的定时器/监听器/watcher 数' }
  })
})

onUnmounted(() => {
  unregisterBenchmark('A')
  mounted.value = false
  forceCleanupBaseline()
})

async function manualMount() {
  mounted.value = false
  await nextTick()
  mountKey.value++
  mounted.value = true
  lastInfo.value = `以当前开关挂载(scope=${flags.scope}, chunk=${flags.chunk})`
}
</script>

<template>
  <section data-perf-scope="A">
    <h2>场景 A · 挂载阶段 320 个注册任务</h2>
    <p class="desc">
      320 个初始化任务(含优先级 critical/visible/idle、闭包状态、相互依赖), 约 1/5 注册副作用(定时器/全局监听/watcher)。
      基线: setup 同步全量执行 + 副作用模块级散管。优化: critical 同步 + 分片调度(A2) + effectScope 统一销毁(A1)。
    </p>
    <div class="ops">
      <button @click="manualMount">以当前开关重新挂载</button>
      <button @click="mounted = false">卸载</button>
      <span class="hint">{{ lastInfo }} · 残留探针: interval={{ residue.intervals }} listener={{ residue.listeners }} watcher={{ residue.watchers }} leakedTicks={{ residue.leakedTicks }}</span>
    </div>
    <ScenarioARunner v-if="mounted" :key="mountKey" />
    <p v-else class="hint">(未挂载) runState.phase={{ runState.phase }}</p>
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
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.hint {
  color: #888;
  font-size: 12px;
}
</style>
