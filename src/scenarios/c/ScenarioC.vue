<script setup lang="ts">
import { reactive, ref, shallowRef, computed, onMounted, onUnmounted } from 'vue'
import { effectiveFlags } from '../../perf/flags'
import {
  trackedWatch,
  countFlush,
  startFrameMonitor,
  stopFrameMonitor,
  frameMonitor,
  startHeapMonitor,
  stopHeapMonitor,
} from '../../perf/obs'
import { createStreamBuffer, type DropPolicy } from '../../perf/stream'
import { frameBoundary } from '../../perf/scheduler'
import { beginWindow, collectWindow, completeRun, runStore } from '../../perf/runController'
import { createSources, type StreamMsg } from './sources'
import { createBaselineState, handleMessageBaseline } from './baseline'
import { createOptimizedState, createBatchedWriter } from './optimized'
import MessageList from './MessageList.vue'

/**
 * 场景 C：定时器 + rAF + 流式推送（50 条/帧）三源叠加。
 * batch x shallow 两个正交开关：
 *   batch=off：每条消息到达即写（每帧 ~51 轮 flush）
 *   batch=on ：缓冲 + rAF 消费者合帧（每帧 1 轮 flush）+ 背压丢弃
 *   shallow=off：reactive 深响应数组
 *   shallow=on ：shallowRef + triggerRef 批量触发
 */

const flagsNow = effectiveFlags()

// 写路径：四种组合
const baselineState = createBaselineState()
const optimizedState = createOptimizedState()
const buffer = createStreamBuffer<StreamMsg>(240, 'drop-oldest')
const writer = createBatchedWriter(optimizedState, buffer)

// shallow=on 且 batch=off：每条消息整包替换（对照组合）
const shallowDirect = shallowRef<StreamMsg[]>([])

function onMessage(msg: StreamMsg): void {
  if (flagsNow.batch) {
    writer.onMessage(msg)
  } else if (flagsNow.shallow) {
    const next = shallowDirect.value.slice(-99)
    next.push(msg)
    shallowDirect.value = next
    countFlush()
  } else {
    handleMessageBaseline(baselineState, msg)
  }
}

const sources = createSources(onMessage)

// rAF 消费者（batch=on 时每帧合帧；rAF 被节流时 64ms 兜底继续排干）
let draining = false
async function drainLoop(): Promise<void> {
  while (draining) {
    await frameBoundary()
    writer.drainFrame()
  }
}

// 基线 reactive 数组包一层 computed 统一成 ref 形态传给列表组件
const baselineListRef = computed(() => baselineState.list)
// 普通对象持有 ref：避免模板顶层自动解包，把 ref 本身传给列表组件
const listRefs = {
  batched: optimizedState.list,
  shallowDirect,
  baseline: baselineListRef,
}

// 统计派生：必须返回原始值（数组引用不变时 computed 的 hasChanged 会吞掉 triggerRef）
const statsSummary = computed(() => {
  const list = flagsNow.batch
    ? optimizedState.list.value
    : flagsNow.shallow
      ? shallowDirect.value
      : baselineState.list
  let sum = 0
  for (const m of list) sum += m.payload
  return list.length * 1000003 + (sum % 100003)
})

// 手段 2：离屏/隐藏时 pause watcher（统计 watcher 是离屏分支的消费者）
const offscreen = ref(false)
const statsText = ref('')
const statsHandle = trackedWatch(
  statsSummary,
  (v) => {
    statsText.value = `len=${Math.floor(v / 1000003)} sum=${v % 100003}`
  },
  { immediate: true },
)
function applyOffscreen(off: boolean): void {
  if (!flagsNow.pause) return
  if (off) {
    statsHandle.pause()
    sources.stop()
  } else {
    statsHandle.resume() // 恢复后补算一次，不丢依赖
    sources.start()
  }
}
function onToggleOffscreen(): void {
  applyOffscreen(offscreen.value)
}
function onVisibility(): void {
  applyOffscreen(document.hidden)
}
document.addEventListener('visibilitychange', onVisibility)

// 背压策略配置（面板可调）
const dropPolicy = ref<DropPolicy>('drop-oldest')
function applyPolicy(): void {
  buffer.policy = dropPolicy.value
}
applyPolicy()

const runInfo = reactive({ running: false })
let disposed = false

onMounted(() => {
  sources.start()
  if (flagsNow.batch) {
    draining = true
    void drainLoop()
  }
  startFrameMonitor()
  startHeapMonitor()
  if (runStore.pending === 'c') {
    runInfo.running = true
    const win = beginWindow()
    window.setTimeout(() => {
      if (disposed) return
      stopFrameMonitor()
      const metrics = collectWindow(win)
      const frames = frameMonitor.frames
      completeRun({
        ...metrics,
        frames,
        droppedFrames: frameMonitor.dropped,
        dropRatePct: frames > 0 ? (frameMonitor.dropped / frames) * 100 : 0,
        frameJsAvgMs: frameMonitor.jsAvg,
        frameJsP95Ms: frameMonitor.jsP95,
        frameDeltaP95Ms: frameMonitor.deltaP95,
        droppedMsgs: buffer.dropped,
      })
      runInfo.running = false
    }, 4000)
  }
})

onUnmounted(() => {
  disposed = true
  sources.stop()
  draining = false
  stopFrameMonitor()
  stopHeapMonitor()
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <section class="scenario">
    <h2>场景 C：定时器 + rAF + 流推送（50 条/帧）三源叠加</h2>
    <div class="toolbar">
      <label>
        <input type="checkbox" v-model="offscreen" @change="onToggleOffscreen" />
        模拟离屏（{{ flagsNow.pause ? 'pause watcher + 停源' : '常开（基线）' }}）
      </label>
      <label v-if="flagsNow.batch">
        背压策略：
        <select v-model="dropPolicy" @change="applyPolicy">
          <option value="drop-oldest">丢最旧</option>
          <option value="drop-newest">拒最新</option>
          <option value="unbounded">不丢弃（对照）</option>
        </select>
      </label>
      <span>缓冲: {{ buffer.size }}</span>
      <span>已丢弃: {{ buffer.dropped }}</span>
      <span>统计 watcher: {{ statsText }}</span>
      <span v-if="runInfo.running">自动复跑采样中（4s）…</span>
    </div>
    <MessageList v-if="flagsNow.batch" :list-ref="listRefs.batched" />
    <MessageList v-else-if="flagsNow.shallow" :list-ref="listRefs.shallowDirect" />
    <MessageList v-else :list-ref="listRefs.baseline" />
  </section>
</template>
