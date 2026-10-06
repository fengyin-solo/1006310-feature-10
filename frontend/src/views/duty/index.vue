<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>运维值班交接管理</h2>
        <p class="page-desc">存量台账按交接班次迁移，缺项补齐或显式留空；待办清单与值班台账同步变化，对账条数对得上。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="runReconcile">对账（台账 ↔ 待办）</button>
        <button class="btn" type="button" @click="exportRows">导出运维值班交接清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="reconcileMsg" :class="reconcileOk ? 'ok-text' : 'error-text'">{{ reconcileMsg }}</p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
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
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无运维值班交接数据</td>
        </tr>
      </tbody>
    </table>

    <h3 class="todo-title">待办清单（与值班台账同步）</h3>
    <table class="data-table">
      <thead>
        <tr><th>待办事项</th><th>值班日期</th><th>班次</th><th>状态</th><th>生成时间</th><th>办结时间</th></tr>
      </thead>
      <tbody>
        <tr v-for="todo in todos" :key="todo.id">
          <td>{{ todo.title }}</td>
          <td>{{ todo.date || '待补录' }}</td>
          <td>{{ todo.shift || '待补录' }}</td>
          <td>{{ todo.status }}</td>
          <td>{{ todo.createdAt }}</td>
          <td>{{ todo.doneAt || '—' }}</td>
        </tr>
        <tr v-if="!todos.length">
          <td colspan="6" class="empty-state">暂无待办；点上方「对账」按值班台账生成</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条值班交接记录 · 待办 {{ todos.length }} 条（待办 {{ openTodos }} / 遗留 {{ legacyTodos }} / 已办 {{ doneTodos }}）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
)
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listDutyTodos,
  listEntries,
  moduleMeta,
  reconcileDutyTodos,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, TodoItem } from '@/data/types'

const meta = moduleMeta('duty')
const session = useSessionStore()
const columns = ['交接编号', '值班班组', '值班日期', '班次', '值班人员', '交接事项', '交接人员', '交接状态']
const actions = ['发起交接', '确认交接', '登记遗留']
const statuses = ['待交接', '交接中', '已交接', '有遗留']
const stats = computed(() => [
  { label: '待交接班次', value: rows.value.filter((row) => String(row.status) === '待交接').length },
  { label: '已交接班次', value: rows.value.filter((row) => String(row.status) === '已交接').length },
  { label: '有遗留事项', value: rows.value.filter((row) => String(row.status) === '有遗留').length },
])

const rows = ref<EntryRow[]>([])
const todos = ref<TodoItem[]>([])
const total = ref(0)
const errorMessage = ref('')
const reconcileMsg = ref('')
const reconcileOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const openTodos = computed(() => todos.value.filter((item) => item.status === '待办').length)
const legacyTodos = computed(() => todos.value.filter((item) => item.status === '遗留').length)
const doneTodos = computed(() => todos.value.filter((item) => item.status === '已办').length)

function formatCell(row: EntryRow, field: string): string {
  const value = row[field]
  if (value === undefined || value === null || String(value) === '') {
    return '待补录'
  }
  return String(value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runReconcile() {
  try {
    const result = reconcileDutyTodos()
    reload()
    reconcileOk.value = result.matched
    reconcileMsg.value = result.matched
      ? `对账一致：值班台账 ${result.dutyTotal} 条，待办清单 ${result.todoTotal} 条（未办结 ${result.openTodos}、遗留 ${result.legacyTodos}）`
      : `对账有偏差：台账 ${result.dutyTotal} 条、待办 ${result.todoTotal} 条，已按台账重算待办，请再对一次`
  } catch (error) {
    reconcileOk.value = false
    reconcileMsg.value = error instanceof Error ? error.message : '对账失败'
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  reconcileMsg.value = ''
  const result = applyAction(meta.key, Number(row.id), action, session.operator)
  reload()
  if (!result.ok) {
    errorMessage.value = result.message
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    todos.value = listDutyTodos()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '运维值班交接列表读取失败'
  }
}

onMounted(() => {
  // 进页面先按台账对一次，保证待办清单与值班台账一致。
  try {
    reconcileDutyTodos()
  } catch {
    // 落库失败的原因会在操作时报出，首次进入不打断浏览。
  }
  reload()
})
</script>

<style scoped>
.todo-title { margin: 20px 0 8px; font-size: 15px; }
.ok-text { color: #15803d; font-size: 13px; }
.error-text { color: #b42318; font-size: 13px; }
</style>
