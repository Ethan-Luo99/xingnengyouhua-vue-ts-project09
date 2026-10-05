<script setup lang="ts">
import { reactive, effectScope, onUnmounted, nextTick } from 'vue'
import type { Scheduler } from '../../perf/scheduler'
import { effectiveFlags } from '../../perf/flags'
import { beginWindow, collectWindow, completeRun, completeProbe } from '../../perf/runController'
import { mark, measure } from '../../perf/obs'
import { aProbe } from './probe'
import {
  TASK_COUNT,
  PROBE_EVENT,
  probeSource,
  buildTasks,
  createRegistry,
  runAllSync,
  runAllChunked,
  type TaskCtx,
} from './tasks'

/**
 * 场景 A：挂载阶段集中执行 360 个注册任务。
 * sched=off → 同步长任务（基线）；sched=on → 8ms 分片调度。
 * scope=off → 模块级 detached scope 永不停止（残留）；scope=on → 组件 scope 卸载即停。
 */

const flagsNow = effectiveFlags()
const tasks = buildTasks(TASK_COUNT)
const registry = createRegistry()
const ctx: TaskCtx = { results: new Map(), registry }

const state = reactive({
  phase: 'running' as 'running' | 'done',
  executed: 0,
  mode: '',
})

const win = beginWindow()
let disposed = false
let scheduler: Scheduler | null = null
const ownedScope = flagsNow.scope ? effectScope() : null
// scope=off：模块级 detached scope，永不 stop —— 模拟“模块级注册中心”泄漏写法
const taskScope = ownedScope ?? effectScope(true)
registry.scope = taskScope

function finish(): void {
  mark('a:exec:end')
  const execMs = measure('a:exec', 'a:exec:start', 'a:exec:end')
  state.executed = ctx.results.size
  // 等 longtask 条目送达后再采集（PerformanceObserver 异步回调）
  window.setTimeout(() => {
    if (disposed) return // 已卸载：不回传，避免污染编排中的后续运行
    state.phase = 'done'
    const metrics = collectWindow(win)
    completeRun({
      ...metrics,
      tasks: ctx.results.size,
      execMs,
    })
  }, 200)
}

mark('a:exec:start')
if (flagsNow.sched) {
  state.mode = '分片调度'
  scheduler = runAllChunked(tasks, ctx, taskScope, () => finish())
} else {
  state.mode = '同步长任务'
  runAllSync(tasks, ctx, taskScope)
  finish()
}

onUnmounted(() => {
  disposed = true
  scheduler?.dispose()
  // 手段 1 验收：卸载后行为断言 —— 探针事件不应再触发任何残留副作用
  ownedScope?.stop()
  const before = {
    listeners: registry.listenerFires,
    watchers: registry.watcherFires,
    ticks: registry.intervalTicks,
  }
  window.dispatchEvent(new Event(PROBE_EVENT))
  probeSource.value++
  void nextTick()
    .then(() => new Promise((r) => setTimeout(r, 130)))
    .then(() => {
      aProbe.ran = true
      aProbe.listenerFires = registry.listenerFires - before.listeners
      aProbe.watcherFires = registry.watcherFires - before.watchers
      aProbe.intervalTicks = registry.intervalTicks - before.ticks
      completeProbe({
        residualListeners: aProbe.listenerFires,
        residualWatchers: aProbe.watcherFires,
        residualIntervals: aProbe.intervalTicks,
      })
      // 泄漏已被探针证实；清理基线残留保持页面可用
      registry.disposeAll()
    })
})
</script>

<template>
  <section class="scenario">
    <h2>场景 A：挂载阶段 360 个注册任务</h2>
    <p class="desc">
      模式：<b>{{ state.mode }}</b>；scope 治理：<b>{{ flagsNow.scope ? 'effectScope 统一管理' : '模块级 detached scope（泄漏写法）' }}</b>
    </p>
    <p>
      状态：{{ state.phase === 'running' ? '执行中…' : '完成' }}；已注册任务 {{ state.executed }} / {{ TASK_COUNT }}
    </p>
    <p class="hint">卸载本场景（切换标签页）后，面板“残留探针”显示卸载后仍触发的副作用数（优化态应为 0）。</p>
  </section>
</template>
