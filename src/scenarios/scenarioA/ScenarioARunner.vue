<script setup lang="ts">
import { onUnmounted, effectScope } from 'vue'
import { flags } from '../../perf/flags'
import { mark, measure } from '../../perf/metrics'
import { ChunkScheduler } from '../../perf/scheduler'
import {
  buildTasks,
  topoSort,
  priorityWeight,
  makeScopedRegisterEffect,
  makeLeakyRegisterEffect,
  setCurrentScheduler,
  runState,
  type TaskContext,
} from './tasks'

/**
 * 挂载阶段集中执行 320 个注册任务:
 * - 基线(全关): setup 同步全部执行 -> 单个 >50ms 长任务; 副作用模块级散管 -> 卸载后泄漏
 * - chunk: critical 同步, visible/idle 进分片调度器(8ms 帧预算)
 * - scope: 全部副作用注册进 pageScope, onScopeDispose 统一销毁
 */

const tasks = topoSort(buildTasks(runState.total))
const results: number[] = new Array(tasks.length).fill(0)
const scope = effectScope()
const scheduler = flags.chunk ? new ChunkScheduler({ budgetMs: 8, frameAligned: true }) : null
setCurrentScheduler(scheduler)

const registerEffect = flags.scope ? makeScopedRegisterEffect(scope) : makeLeakyRegisterEffect()
const ctx: TaskContext = { results, registerEffect }

runState.mounted = true
runState.done = 0
runState.phase = '挂载中'

mark('A:mount:start')

if (flags.chunk && scheduler) {
  // 优化: critical 同步保证首帧, 其余按优先级进帧队列分片消费
  for (const t of tasks) {
    if (t.priority === 'critical') {
      t.run(ctx)
      runState.done++
    } else {
      void scheduler
        .enqueue(
          () => {
            t.run(ctx)
            runState.done++
          },
          { priority: priorityWeight[t.priority] },
        )
        .catch(() => {})
    }
  }
  runState.phase = '分片执行中'
  void scheduler.whenIdle().then(() => {
    runState.phase = '完成'
    mark('A:all:end')
    measure('A 全部任务完成', 'A:mount:start', 'A:all:end')
  })
} else {
  // 基线: 320 个任务在 setup 同步段全部执行完(单个长任务)
  for (const t of tasks) {
    t.run(ctx)
    runState.done++
  }
  runState.phase = '完成'
}

onUnmounted(() => {
  runState.mounted = false
  if (flags.scope) {
    // effectScope 统一销毁: watch/定时器/监听器全部回收
    scope.stop()
  }
  scheduler?.dispose()
  setCurrentScheduler(null)
})
</script>

<template>
  <div class="runner">
    <p>
      初始化任务: {{ runState.done }} / {{ runState.total }} · 阶段: {{ runState.phase }} · 调度器:
      {{ scheduler ? `帧预算 8ms, 已切 ${scheduler.stats.slices} 片, 最大片 ${scheduler.stats.maxSliceMs.toFixed(1)}ms` : '未启用(基线同步执行)' }}
    </p>
    <div class="bar"><div class="bar-inner" :style="{ width: (runState.done / runState.total) * 100 + '%' }"></div></div>
  </div>
</template>

<style scoped>
.runner {
  border: 1px solid #444;
  border-radius: 6px;
  padding: 8px 12px;
  margin: 8px 0;
}
.bar {
  height: 8px;
  background: #333;
  border-radius: 4px;
  overflow: hidden;
}
.bar-inner {
  height: 100%;
  background: #42b883;
  transition: width 0.1s linear;
}
</style>
