<script setup lang="ts">
import RowView from './RowView.vue'
import type { Row } from './store'

/**
 * 300 行 x 8 列表格。
 * memo=on：v-memo 依赖数组 = [row.value, row.status, row.score, row.delta]
 *   —— 覆盖模板读取的全部可变字段（id/name/category 静态不变；
 *      tag 列由 describe(row) 纯函数派生，其输入即这些字段）。
 *   依赖数组漏字段会产生 stale UI，自检里有对应断言。
 * memo=off：无 v-memo + 不稳定 tick prop（基线反模式，全表重渲染）。
 */
defineProps<{
  rows: Row[]
  memoized: boolean
  tick: number
  describe: (r: Row) => string
}>()
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>id</th><th>name</th><th>category</th><th>value</th>
          <th>status</th><th>score</th><th>delta</th><th>tag</th>
        </tr>
      </thead>
      <tbody v-if="memoized">
        <RowView
          v-for="row in rows"
          :key="row.id"
          v-memo="[row.value, row.status, row.score, row.delta]"
          :row="row"
          :describe="describe"
        />
      </tbody>
      <tbody v-else>
        <RowView
          v-for="row in rows"
          :key="row.id"
          :row="row"
          :describe="describe"
          :tick="tick"
        />
      </tbody>
    </table>
  </div>
</template>
