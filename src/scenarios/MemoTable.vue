<script setup lang="ts">
import { ref, shallowRef, nextTick, onMounted, onUnmounted } from 'vue'
import { flags, withFlags } from '../perf/flags'
import { count, counters, resetCounters } from '../perf/metrics'
import { registerBenchmark, unregisterBenchmark } from '../perf/bench'

/**
 * v-memo 优化 300 行 x 8 列表格
 * 依赖数组设计: v-memo="[row.ver]" — ver 是该行的数据版本, 任何字段变更必须 ver++(失效契约);
 *   行对象整包替换, 未变更行保持同一引用同一 ver -> 整行子树跳过 patch。
 * stale 验证: 每次随机部分更新后, 全量比对 DOM 文本与数据源, 不一致即 stale。
 */

interface Row {
  id: number
  ver: number
  cells: string[]
}

const ROWS = 300
const COLS = 8

function makeRow(id: number): Row {
  return { id, ver: 0, cells: Array.from({ length: COLS }, (_, k) => `r${id}c${k}`) }
}

const rows = shallowRef<Row[]>(Array.from({ length: ROWS }, (_, i) => makeRow(i)))
const lastStale = ref<number | null>(null)
const lastChanged = ref(0)

function cell(row: Row, k: number): string {
  count('T 单元渲染次数')
  return row.cells[k]!
}

function randomUpdate(fraction = 0.1) {
  const src = rows.value
  const next = src.slice()
  let changed = 0
  for (const row of src) {
    if (Math.random() < fraction) {
      const cells = row.cells.slice()
      const k = Math.floor(Math.random() * COLS)
      cells[k] = `r${row.id}c${k}#${Math.floor(Math.random() * 1e6)}`
      next[row.id] = { id: row.id, ver: row.ver + 1, cells }
      changed++
    }
  }
  rows.value = next
  lastChanged.value = changed
  return changed
}

/** 全量 stale 校验: DOM 文本必须与数据源一致 */
function verifyNoStale(): number {
  let stale = 0
  const trs = document.querySelectorAll<HTMLTableRowElement>('#memo-table tbody tr')
  for (const tr of trs) {
    const id = Number(tr.dataset['rowid'])
    const row = rows.value[id]!
    for (let k = 0; k < COLS; k++) {
      if (tr.children[k + 1]?.textContent !== row.cells[k]) {
        stale++
        break
      }
    }
  }
  return stale
}

async function updateAndVerify() {
  const t0 = performance.now()
  randomUpdate()
  await nextTick()
  const ms = performance.now() - t0
  lastStale.value = verifyNoStale()
  return ms
}

async function runOnce(mode: 'baseline' | 'optimized') {
  return withFlags({ vmemo: mode === 'optimized' }, async () => {
    await nextTick()
    resetCounters('T ')
    const t0 = performance.now()
    const changed = randomUpdate()
    await nextTick()
    const ms = performance.now() - t0
    const stale = verifyNoStale()
    return {
      '变更行数': changed,
      'patch耗时(ms)': +ms.toFixed(2),
      '单元渲染次数': counters['T 单元渲染次数'] ?? 0,
      'stale行数': stale,
    }
  })
}

onMounted(() => {
  registerBenchmark('T', async () => {
    const baseline = await runOnce('baseline')
    const optimized = await runOnce('optimized')
    return { baseline, optimized, note: '依赖数组 [row.ver]; stale 行数两种模式都必须为 0' }
  })
})

onUnmounted(() => unregisterBenchmark('T'))
</script>

<template>
  <section data-perf-scope="T">
    <h2>v-memo · 300 行 × 8 列表格随机部分更新</h2>
    <p class="desc">
      依赖数组 <code>v-memo="[row.ver]"</code>: 行数据任何字段变更必须 ver++(失效契约), 未变更行整棵子树跳过 patch。
      基线(关): 每次更新全表 2400 个单元重新渲染。
    </p>
    <div class="ops">
      <button @click="updateAndVerify">随机更新 ~10% 行并校验 stale</button>
      <span class="hint">
        本次变更 {{ lastChanged }} 行 · stale 行数:
        <b :style="{ color: lastStale ? '#e66' : '#6c6' }">{{ lastStale === null ? '未验证' : lastStale }}</b>
        · 当前模式: {{ flags.vmemo ? 'v-memo' : '基线' }}
      </span>
    </div>
    <div class="table-wrap">
      <table id="memo-table">
        <thead>
          <tr>
            <th>#</th>
            <th v-for="k in COLS" :key="k">col{{ k - 1 }}</th>
          </tr>
        </thead>
        <tbody v-if="flags.vmemo">
          <tr v-for="row in rows" :key="row.id" v-memo="[row.ver]" :data-rowid="row.id">
            <td>{{ row.id }}</td>
            <td v-for="k in COLS" :key="k">{{ cell(row, k - 1) }}</td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="row in rows" :key="row.id" :data-rowid="row.id">
            <td>{{ row.id }}</td>
            <td v-for="k in COLS" :key="k">{{ cell(row, k - 1) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
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
  gap: 10px;
  align-items: center;
  margin: 6px 0;
}
.hint {
  color: #888;
  font-size: 12px;
}
.table-wrap {
  height: 320px;
  overflow: auto;
  border: 1px solid #333;
  border-radius: 4px;
}
table {
  border-collapse: collapse;
  font-size: 11px;
  font-family: monospace;
  width: 100%;
}
th,
td {
  border: 1px solid #2a2a2a;
  padding: 2px 6px;
  white-space: nowrap;
}
thead {
  position: sticky;
  top: 0;
  background: #1a1a1a;
}
</style>
