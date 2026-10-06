<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>运维值班交接管理</h2>
        <p class="page-desc">存量排水台账按交接班次迁移；确认交接时未闭环泵坑与待办随班迁到下一本台账，待办清单与台账同步变化。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记值班交接记录</button>
        <button class="btn" type="button" @click="exportRows">导出运维值班交接清单</button>
      </div>
    </header>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">对账待办合计：{{ todos.length }} 条（与排水页同一份口径）</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>挂接待办</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ todoCountOf(String(row['交接编号'])) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无运维值班交接数据，可先登记值班交接记录</td>
        </tr>
      </tbody>
    </table>

    <section class="todo-panel">
      <h3>待办清单随台账同步（按台账分组）</h3>
      <table class="data-table">
        <thead>
          <tr><th>值班台账</th><th>班次</th><th>待办数</th><th>待办内容</th></tr>
        </thead>
        <tbody>
          <tr v-for="group in todoGroups" :key="group.交接编号">
            <td>{{ group.交接编号 }}</td>
            <td>{{ group.班次 || '—' }}</td>
            <td>{{ group.items.length }}</td>
            <td>
              <ul class="todo-cell">
                <li v-for="item in group.items" :key="item.id">{{ item.内容 }}</li>
              </ul>
            </td>
          </tr>
          <tr v-if="!todoGroups.length">
            <td colspan="4" class="empty-state">无待办，台账账实相符</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 本值班台账</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmDutyHandover,
  downloadEntries,
  listEntries,
  loadDrainage,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { DrainageView, EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('duty')
const columns = ['交接编号', '值班班组', '值班日期', '班次', '值班人员', '交接事项', '交接人员', '交接状态']
const actions = ['发起交接', '确认交接', '登记遗留']

const rows = ref<EntryRow[]>([])
const drainage = ref<DrainageView>(loadDrainage())
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const filteredRows = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  if (!pairs.length) return rows.value
  return rows.value.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
})

const todos = computed(() => drainage.value.todos)
const todoGroups = computed(() =>
  drainage.value.report.todoCountByLedger
    .map((group) => ({
      ...group,
      items: todos.value.filter((todo) => todo.值班台账 === group.交接编号),
    }))
    .filter((group) => group.items.length > 0),
)

const statusSummary = computed(() =>
  ['待交接', '交接中', '已交接', '有遗留'].map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function todoCountOf(code: string): number {
  return drainage.value.report.todoCountByLedger.find((item) => item.交接编号 === code)?.待办数 ?? 0
}

function resetFilters() {
  filters.value = {}
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '值班交接记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  if (action === '确认交接') {
    const result = confirmDutyHandover(Number(row.id), { operator: store.operator, shift: store.shiftLabel })
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    infoMessage.value = result.message
    reload()
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  const payload = listEntries(meta.key, filters.value)
  rows.value = payload.items
  drainage.value = loadDrainage()
}

onMounted(reload)
</script>
