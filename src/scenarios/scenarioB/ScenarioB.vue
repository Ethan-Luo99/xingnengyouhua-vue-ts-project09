<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, markRaw, nextTick, type WatchHandle } from 'vue'
import { flags, withFlags } from '../../perf/flags'
import { count, counters, resetCounters, longTasksInWindow, afterPaint, mark, measure } from '../../perf/metrics'
import { memoizeLru } from '../../perf/lruMemo'
import { registerBenchmark, unregisterBenchmark } from '../../perf/bench'
import ItemCell from './ItemCell.vue'

/**
 * 场景 B: 单击一次 -> 300+ 函数连锁扇出, 共享响应式数据读写交错
 * 基线: sync watcher 连锁 + 每函数独立重算派生 + 循环内强制同步布局 + 粗粒度渲染依赖
 * 优化: computed 合并派生(B1) + watch flush 分流/DOM 测量 post(B2) + LRU 记忆化纯函数(B3)
 */

const ITEMS = 300
const CELLS = 60

const items = reactive(Array.from({ length: ITEMS }, (_, i) => ({ id: i, val: i })))
const factor = ref(1)
const chainA = ref(0)
const chainB = ref(0)
const chainC = ref(0)
const renderEpoch = ref(0)
const measureTrigger = ref(0)
const clickNo = ref(0)
const listRef = ref<HTMLElement | null>(null)
const lastHandlerMs = ref(0)
const measuredHeight = ref(0)

// ---- 纯函数 + LRU 记忆化(对象键: WeakMap id + 数据版本失效) ----
interface DictEntry {
  code: number
  weight: number
}
const dictVersion = ref(0)
const dictPool = markRaw(
  Array.from({ length: 40 }, (_, i) => ({ code: i, weight: (i * 2654435761) % 1000 }) as DictEntry),
)

function normalizeRecordRaw(entry: DictEntry, salt: number): number {
  count('B 纯函数调用')
  let acc = entry.weight + salt
  for (let i = 0; i < 2000; i++) {
    acc = (acc * 1103515245 + 12345 + i) % 2147483647
    acc ^= acc >>> 13
  }
  return acc + entry.code
}

const normalizeMemo = memoizeLru(normalizeRecordRaw, {
  max: 500,
  version: () => dictVersion.value,
})
const memoHits = computed(() => normalizeMemo.stats.hits)

// ---- 重复派生计算: 基线每函数独立算, 优化共享一个 computed ----
function computeSummaryRaw(): number {
  count('B 派生计算次数')
  let acc = 0
  for (const it of items) {
    for (let k = 0; k < 50; k++) acc += Math.sqrt((it.val + k) % 997)
  }
  return acc
}
const summary = computed(() => computeSummaryRaw())

// ---- watcher 图: flush 由开关决定(sync 是反模式, pre 是规范) ----
let handles: WatchHandle[] = []
function buildWatchers() {
  for (const h of handles) h.stop()
  handles = []
  const flush = flags.flush ? 'pre' : 'sync'
  for (let i = 0; i < 20; i++) {
    handles.push(
      watch(
        chainA,
        (v) => {
          count('B watcher 触发')
          chainB.value = v + i
        },
        { flush },
      ),
    )
  }
  for (let i = 0; i < 10; i++) {
    handles.push(
      watch(
        chainB,
        (v) => {
          count('B watcher 触发')
          chainC.value = v + i
        },
        { flush },
      ),
    )
  }
}
buildWatchers()
const stopFlagWatch = watch(() => flags.flush, buildWatchers)

// DOM 测量统一 post: 优化模式只在 flush 后测一次
watch(
  measureTrigger,
  () => {
    if (!flags.flush) return
    count('B 强制布局次数')
    measuredHeight.value = listRef.value?.scrollHeight ?? 0
  },
  { flush: 'post' },
)

// ---- 300 个扇出函数: 共享响应式数据读写交错 ----
const writeFns = Array.from({ length: ITEMS }, (_, i) => () => {
  count('B 扇出函数执行')
  const shared = factor.value // 读共享
  if ((i + clickNo.value) % 4 === 0) {
    items[i]!.val += shared // 仅 1/4 的项真实变化(渲染受影响面)
  }
  if (i % 3 === 0) chainA.value++ // 触发 watcher 连锁
  if (i % 7 === 0) factor.value = shared + (items[(i + 1) % ITEMS]!.val % 3) // 读写交错
  // 纯函数记忆化演示: 对象入参, 高重复率
  const entry = dictPool[i % 40]!
  if (flags.memo) void normalizeMemo(entry, i % 16)
  else void normalizeRecordRaw(entry, i % 16)
  // 基线: 循环内写后立刻读布局 -> 强制同步布局; 优化: 交给 post watcher
  if (!flags.flush && i % 15 === 0) {
    count('B 强制布局次数')
    measuredHeight.value = listRef.value?.scrollHeight ?? 0
  }
})

function fanout() {
  mark('B:interaction:start')
  const t0 = performance.now()
  clickNo.value++
  renderEpoch.value++
  if (flags.computed) {
    // 写入收敛: 先同步完成全部源状态写入, 再统一读派生 —— 同一 flush 内 60 次读取只重算 1 次
    for (const fn of writeFns) fn()
    for (let i = 0; i < 60; i++) void summary.value
  } else {
    // 基线: 边写边独立重算(交错读写, 每 5 个函数重算一次完整派生)
    for (let i = 0; i < writeFns.length; i++) {
      writeFns[i]!()
      if (i % 5 === 0) void computeSummaryRaw()
    }
  }
  measureTrigger.value++
  mark('B:interaction:end')
  lastHandlerMs.value = performance.now() - t0
  measure('B 事件处理同步段', 'B:interaction:start', 'B:interaction:end')
}

async function runOnce(mode: 'baseline' | 'optimized') {
  const patch =
    mode === 'optimized' ? { computed: true, flush: true, memo: true } : { computed: false, flush: false, memo: false }
  return withFlags(patch, async () => {
    await nextTick() // 等 watcher 图按新开关重建
    resetCounters('B ')
    normalizeMemo.clear()
    const t0 = performance.now()
    fanout()
    const tEnd = await afterPaint()
    const longTasks = longTasksInWindow(t0 - 1, tEnd + 50)
    return {
      '交互总时长(ms)': +(tEnd - t0).toFixed(1),
      '长任务数(>50ms)': longTasks.length,
      'watcher 触发次数': count0('B watcher 触发'),
      '派生计算次数': count0('B 派生计算次数'),
      '渲染组件数': count0('B 渲染组件数'),
      '纯函数调用': count0('B 纯函数调用'),
      '记忆化命中': normalizeMemo.stats.hits,
      '强制布局次数': count0('B 强制布局次数'),
    }
  })
}

function count0(name: string): number {
  return counters[name] ?? 0
}

onMounted(() => {
  registerBenchmark('B', async () => {
    const baseline = await runOnce('baseline')
    const optimized = await runOnce('optimized')
    return {
      baseline,
      optimized,
      note: '自动复跑用合成调用测"处理+呈现"时长; 真实 INP P95 请在页面上手动点击后看面板(合成事件不计入 Event Timing)',
    }
  })
})

onUnmounted(() => {
  unregisterBenchmark('B')
  for (const h of handles) h.stop()
  stopFlagWatch()
})

const visibleItems = computed(() => items.slice(0, CELLS))
</script>

<template>
  <section data-perf-scope="B">
    <h2>场景 B · 单击触发 300+ 函数连锁扇出</h2>
    <p class="desc">
      一次点击执行 300 个扇出函数: 共享 factor 读写交错、30 个 watcher 连锁、60 次重复派生、300 次纯函数(词典对象入参)。
      优化开关: B1 computed 合并派生 · B2 watch flush 分流(禁 sync, DOM 测量 post) · B3 LRU 记忆化。
    </p>
    <div class="ops">
      <button data-perf-scope="B" @click="fanout">触发扇出(真实点击计入 INP)</button>
      <button @click="dictVersion++">重载词典(version++ 缓存整体失效)</button>
      <span class="hint">
        本次 handler 同步段 {{ lastHandlerMs.toFixed(1) }}ms · chainC={{ chainC }} · 测量高度={{ measuredHeight }} · memo 命中={{ memoHits }}
      </span>
    </div>
    <div ref="listRef" class="grid">
      <ItemCell
        v-for="it in visibleItems"
        :key="it.id"
        :id="it.id"
        :val="it.val"
        :epoch="flags.flush ? undefined : renderEpoch"
      />
    </div>
    <p class="hint">仅前 {{ CELLS }} 个单元上屏; 每次点击仅 1/4 项真实变化, 优化后渲染组件数应≈受影响节点数。</p>
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
  margin-bottom: 8px;
}
.hint {
  color: #888;
  font-size: 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 3px;
  max-height: 220px;
  overflow: auto;
}
</style>
