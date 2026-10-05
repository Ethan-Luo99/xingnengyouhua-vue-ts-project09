<script setup lang="ts">
import { reactive, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { effectiveFlags } from '../../perf/flags'
import { trackedWatch, trackedComputed, mark, measure } from '../../perf/obs'
import { memoize } from '../../perf/lru'
import { beginWindow, collectWindow, completeRun, runStore } from '../../perf/runController'
import {
  makeRows,
  createSharedState,
  calcStats,
  describeRow,
  FANOUT_COUNT,
  AFFECTED_ROWS,
} from './store'
import { fanOutBaseline } from './baseline'
import { fanOutOptimized } from './optimized'
import DataTable from './DataTable.vue'

const flagsNow = effectiveFlags()
const rows = makeRows()
const shared = createSharedState()
const affectedRows = new Set<number>()

// 手段 4：computed 合并派生（on）vs 命令式 statsRef 快照（off）
const statsComputed = trackedComputed(() => calcStats(rows))
const statsSource = flagsNow.computed ? statsComputed : shared.statsRef

// 手段 8：LRU 记忆化（对象入参键：(row, row.value, row.status) 身份字典树）
const memoDescribe = memoize((r: (typeof rows)[number], _status: string, _score: number) => describeRow(r), { maxSize: 512 })
const describe = flagsNow.lru ? (r: (typeof rows)[number]) => memoDescribe(r, r.status, r.score) : describeRow

// 表格 DOM 测量（手段 5：统一 post；基线 sync 演示布局抖动）
const tableWrap = ref<HTMLElement | null>(null)
function measureDom(): void {
  if (tableWrap.value) {
    shared.measuredHeight.value = tableWrap.value.getBoundingClientRect().height
  }
}

// 手段 5：watch flush 时机分流
if (flagsNow.flush) {
  trackedWatch(shared.chainBus, () => { shared.chain2.value++ })
  trackedWatch(shared.chain2, () => { shared.chain3.value++ })
  trackedWatch(statsSource, () => measureDom(), { flush: 'post' })
} else {
  trackedWatch(shared.chainBus, () => { shared.chain2.value++ }, { flush: 'sync' })
  trackedWatch(shared.chain2, () => { shared.chain3.value++ }, { flush: 'sync' })
  trackedWatch(statsSource, () => measureDom(), { flush: 'sync' })
}

// 手段 2：隐藏面板 watcher pause/resume
const panelVisible = ref(true)
const detailsHandle = trackedWatch(statsSource, (s) => {
  shared.detailsText.value = `total=${s.total} max=${s.max} crit=${s.critCount}`
})
watch(panelVisible, (visible) => {
  if (!flagsNow.pause) return
  if (visible) detailsHandle.resume()
  else detailsHandle.pause()
})

const runStats = reactive({
  runs: 0,
  lastHandlerMs: 0,
  staleMismatches: -1,
})

function onFanOut(): void {
  affectedRows.clear()
  mark('fanout:start')
  if (flagsNow.computed) {
    fanOutOptimized({ rows, shared, statsSource, affectedRows }, FANOUT_COUNT, AFFECTED_ROWS)
  } else {
    fanOutBaseline({ rows, shared, statsSource, affectedRows }, FANOUT_COUNT, AFFECTED_ROWS)
  }
  shared.tick.value++ // 基线反模式：不稳定 prop 强制全表重渲染
  mark('fanout:end')
  runStats.lastHandlerMs = measure('fanout', 'fanout:start', 'fanout:end')
  runStats.runs++
}

/** stale UI 断言：受影响行的 DOM 单元格必须与数据一致 */
function assertNoStaleUi(): number {
  let mismatches = 0
  for (const idx of affectedRows) {
    const cell = document.querySelector(`tr[data-row-id="${idx}"] td[data-col="value"]`)
    if (cell === null || cell.textContent !== String(rows[idx]!.value)) mismatches++
  }
  return mismatches
}

let disposed = false
onUnmounted(() => {
  disposed = true
})

onMounted(() => {
  if (runStore.pending !== 'b') return
  // 面板编排的自动复跑：等初始渲染稳定后执行一次扇出
  window.setTimeout(() => {
    if (disposed) return
    const win = beginWindow()
    onFanOut()
    void nextTick()
      .then(() => new Promise((r) => setTimeout(r, 120)))
      .then(() => {
        if (disposed) return
        runStats.staleMismatches = assertNoStaleUi()
        const metrics = collectWindow(win)
        completeRun({
          ...metrics,
          handlerMs: runStats.lastHandlerMs,
          staleMismatches: runStats.staleMismatches,
          memoHits: memoDescribe.hits,
          memoMisses: memoDescribe.misses,
        })
      })
  }, 100)
})
</script>

<template>
  <section class="scenario">
    <h2>场景 B：单击扇出 {{ FANOUT_COUNT }} 函数链（影响 {{ AFFECTED_ROWS }} 行）</h2>
    <div class="toolbar">
      <button class="primary" @click="onFanOut">触发扇出（真实点击计 INP）</button>
      <label>
        <input type="checkbox" v-model="panelVisible" />
        显示详情面板（pause/resume 演示）
      </label>
      <span>handler: {{ runStats.lastHandlerMs.toFixed(1) }}ms</span>
      <span>chain3: {{ shared.chain3.value }}</span>
      <span>mirror: {{ shared.mirror.value }}</span>
      <span>表高: {{ shared.measuredHeight.value.toFixed(0) }}px</span>
      <span v-if="runStats.staleMismatches >= 0">
        stale 断言: {{ runStats.staleMismatches === 0 ? '通过' : `${runStats.staleMismatches} 处不一致` }}
      </span>
    </div>
    <div v-show="panelVisible" class="details">
      详情面板（隐藏时 watcher {{ flagsNow.pause ? 'pause' : '常开' }}）：{{ shared.detailsText.value || '等待首次扇出' }}
    </div>
    <div ref="tableWrap">
      <DataTable :rows="rows" :memoized="flagsNow.memo" :tick="shared.tick.value" :describe="describe" />
    </div>
  </section>
</template>
