<template>
  <section class="page" data-module="drainage">
    <header class="page-head">
      <div>
        <h2>廊内排水运维管理</h2>
        <p class="page-desc">泵坑编号、集水坑容积、当前水位、启泵水位一次落库、原地覆盖；列表、详情、概览读同一份，刷新或退出重进不回档。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记排水泵坑</button>
        <button class="btn" type="button" @click="runReconcile">立即对账</button>
        <button class="btn" type="button" @click="exportRows">导出廊内排水运维清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">对账：{{ view.report.message }}</span>
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
          <th>值班台账</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredPits" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayValue(row, column) }}</td>
          <td>{{ row.值班台账 || '待补挂' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.补录标记" class="tag" :title="row.补录标记">{{ row.补录标记.includes('留空') ? '待核定' : '已补值' }}</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情/修改</button>
            <button class="link" type="button" @click="runAction('启动排水', row)">启动排水</button>
            <button class="link" type="button" @click="runAction('确认正常', row)">确认正常</button>
            <button class="link" type="button" @click="runAction('上报故障', row)">上报故障</button>
          </td>
        </tr>
        <tr v-if="!filteredPits.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无廊内排水运维数据，可先登记排水泵坑</td>
        </tr>
      </tbody>
    </table>

    <section class="todo-panel">
      <h3>对账待办清单（与值班台账同步，共 {{ view.todos.length }} 条）</h3>
      <table class="data-table">
        <thead>
          <tr><th>待办内容</th><th>类型</th><th>挂接台账</th><th>班次</th></tr>
        </thead>
        <tbody>
          <tr v-for="todo in view.todos" :key="todo.id">
            <td>{{ todo.内容 }}</td>
            <td>{{ todo.kind }}</td>
            <td>{{ todo.值班台账 || '待补挂' }}</td>
            <td>{{ todo.班次 || '—' }}</td>
          </tr>
          <tr v-if="!view.todos.length">
            <td colspan="4" class="empty-state">对账无待办，账实相符</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ view.pits.length }} 条廊内排水运维记录 · 保存采用覆盖口径（不另存新版本），操作历史只追加不改写</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
    </footer>

    <div v-if="dialog.open" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <header class="modal-head">
          <h3>{{ dialog.mode === 'create' ? '登记排水泵坑' : `泵坑详情 / 修改 · ${dialog.form.泵坑编号}` }}</h3>
          <button class="btn ghost" type="button" @click="closeDialog">关闭</button>
        </header>

        <div class="modal-body">
          <div v-if="dialog.mode === 'edit' && dialog.pit" class="detail-grid">
            <span>所属舱室</span><strong>{{ dialog.pit.所属舱室 }}</strong>
            <span>排水泵编号</span><strong>{{ dialog.pit.排水泵编号 }}</strong>
            <span>值班人员</span><strong>{{ dialog.pit.值班人员 }}</strong>
            <span>上次巡检日期</span><strong>{{ dialog.pit.上次巡检日期 }}</strong>
            <span>值班台账</span><strong>{{ dialog.pit.值班台账 }}（{{ dialog.pit.交接班次 }}）</strong>
            <span>迁移/补录标记</span><strong>{{ dialog.pit.补录标记 || '新口径数据' }}</strong>
          </div>

          <form class="edit-form" @submit.prevent="submitDialog">
            <label v-if="dialog.mode === 'create'" class="form-item">
              <span>所属舱室</span>
              <input v-model="dialog.form.所属舱室" placeholder="如：综合舱A段" />
            </label>
            <label class="form-item">
              <span>泵坑编号</span>
              <input v-model="dialog.form.泵坑编号" placeholder="如：DRAI-0008" />
            </label>
            <label class="form-item">
              <span>集水坑容积 (m³)</span>
              <input v-model="dialog.form.集水坑容积" inputmode="decimal" placeholder="如：12.0" />
            </label>
            <label class="form-item">
              <span>当前水位 (m)</span>
              <input v-model="dialog.form.当前水位" inputmode="decimal" placeholder="如：1.72" />
            </label>
            <label class="form-item">
              <span>启泵水位 (m)</span>
              <input
                v-model="dialog.form.启泵水位"
                inputmode="decimal"
                :placeholder="dialog.mode === 'edit' && dialog.pit && !dialog.pit.启泵水位 ? '待核定（请现场补录）' : '如：1.50'"
              />
              <small v-if="dialog.mode === 'edit' && dialog.pit && !dialog.pit.启泵水位" class="warn-text">
                早年未登记且同舱无参照样本，当前显式留空；补录时必须给值，缺项一并补齐
              </small>
            </label>

            <p class="form-hint">
              保存口径：四项一次覆盖落库，不另存新版本；水位越过启泵线自动进入排水中，低于启泵线确认后回落正常。
            </p>
            <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
            <div class="modal-actions">
              <button class="btn primary" type="submit">{{ dialog.mode === 'create' ? '登记并落库' : '覆盖保存' }}</button>
              <button class="btn ghost" type="button" @click="closeDialog">取消</button>
            </div>
          </form>

          <section v-if="dialog.mode === 'edit'" class="history-panel">
            <h4>该泵坑历史记录（原口径保留，只追加不改写）</h4>
            <ul v-if="pitHistory.length">
              <li v-for="item in pitHistory" :key="item.id">
                <strong>{{ item.时间 }}</strong> · {{ item.操作 }} · {{ item.说明 }}
                <em>（{{ item.操作员 }} / {{ item.班次 }}）</em>
              </li>
            </ul>
            <p v-else class="empty-state">暂无历史记录</p>
          </section>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listDrainagePitHistory,
  loadDrainage,
  registerDrainagePit,
  runDrainageAction,
  runDrainageReconcile,
  saveDrainagePit,
} from '@/api/local-service'
import { BLANK_LEVEL_LABEL, DRAINAGE_KEY, PIT_EDITABLE_FIELDS } from '@/data/drainage'
import { useSessionStore } from '@/stores/session'
import type { DrainageHistoryEntry, DrainagePit, DrainageView } from '@/data/types'

const store = useSessionStore()
const columns = ['泵坑编号', '所属舱室', '集水坑容积', '当前水位', '启泵水位', '排水泵编号', '值班人员']
const filterFields = ['泵坑编号', '所属舱室', '集水坑容积']

const view = ref<DrainageView>(loadDrainage())
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})

const filteredPits = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  if (!pairs.length) return view.value.pits
  return view.value.pits.filter((pit) =>
    pairs.every(([field, value]) => String(pit[field] ?? '').includes(value.trim())),
  )
})

const statusSummary = computed(() =>
  ['待排水', '排水中', '水位正常', '水泵故障'].map((status) => ({
    status,
    count: view.value.pits.filter((pit) => pit.status === status).length,
  })),
)

const statCards = computed(() => [
  { label: '待排水泵坑（含排水中）', value: view.value.stats['待排水泵坑'] ?? 0 },
  { label: '排水中泵坑', value: view.value.stats['排水中泵坑'] ?? 0 },
  { label: '水位正常泵坑', value: view.value.stats['水位正常泵坑'] ?? 0 },
  { label: '水泵故障数', value: view.value.stats['水泵故障数'] ?? 0 },
  { label: '启泵水位待核定', value: view.value.stats['待核定启泵水位'] ?? 0 },
  { label: '对账待办', value: view.value.todos.length },
])

function displayValue(row: DrainagePit, column: string): string {
  const value = row[column]
  if (column === '启泵水位' && (value === '' || value === undefined || value === null)) return BLANK_LEVEL_LABEL
  return String(value ?? '—')
}

function resetFilters() {
  filters.value = {}
}

function exportRows() {
  downloadEntries(DRAINAGE_KEY)
}

function reload() {
  view.value = loadDrainage()
}

function actor() {
  return { operator: store.operator, shift: store.shiftLabel }
}

function runAction(action: string, row: DrainagePit) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = runDrainageAction(Number(row.id), action, actor())
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function runReconcile() {
  errorMessage.value = ''
  try {
    view.value = runDrainageReconcile(actor())
    infoMessage.value = view.value.report.message
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '对账失败'
  }
}

type DialogState = {
  open: boolean
  mode: 'edit' | 'create'
  pit: DrainagePit | null
  form: {
    所属舱室: string
    泵坑编号: string
    集水坑容积: string
    当前水位: string
    启泵水位: string
  }
}

const dialog = reactive<DialogState>({
  open: false,
  mode: 'edit',
  pit: null,
  form: { 所属舱室: '', 泵坑编号: '', 集水坑容积: '', 当前水位: '', 启泵水位: '' },
})
const dialogError = ref('')
const pitHistory = ref<DrainageHistoryEntry[]>([])

function openCreate() {
  dialog.open = true
  dialog.mode = 'create'
  dialog.pit = null
  dialog.form = { 所属舱室: '', 泵坑编号: '', 集水坑容积: '', 当前水位: '', 启泵水位: '' }
  dialogError.value = ''
  pitHistory.value = []
}

function openDetail(row: DrainagePit) {
  const fresh = view.value.pits.find((pit) => pit.id === row.id) ?? row
  dialog.open = true
  dialog.mode = 'edit'
  dialog.pit = fresh
  dialog.form = {
    所属舱室: fresh.所属舱室,
    泵坑编号: fresh.泵坑编号,
    集水坑容积: fresh.集水坑容积,
    当前水位: fresh.当前水位,
    启泵水位: fresh.启泵水位,
  }
  dialogError.value = ''
  pitHistory.value = listDrainagePitHistory(fresh.泵坑编号)
}

function closeDialog() {
  dialog.open = false
  dialog.pit = null
  reload()
}

function submitDialog() {
  dialogError.value = ''
  if (dialog.mode === 'create') {
    if (!dialog.form.所属舱室.trim()) {
      dialogError.value = '所属舱室不能为空，补录时缺项要一并补齐'
      return
    }
    const result = registerDrainagePit(
      {
        泵坑编号: dialog.form.泵坑编号,
        集水坑容积: dialog.form.集水坑容积,
        当前水位: dialog.form.当前水位,
        启泵水位: dialog.form.启泵水位,
        所属舱室: dialog.form.所属舱室,
      },
      actor(),
    )
    if (!result.ok) {
      dialogError.value = result.message
      return
    }
    infoMessage.value = result.message
    dialog.open = false
    reload()
    return
  }
  if (!dialog.pit) return
  const draft = Object.fromEntries(PIT_EDITABLE_FIELDS.map((field) => [field, dialog.form[field]])) as Record<
    (typeof PIT_EDITABLE_FIELDS)[number],
    string
  >
  const result = saveDrainagePit(dialog.pit.id, draft, actor())
  if (!result.ok) {
    dialogError.value = result.message
    return
  }
  infoMessage.value = result.message
  pitHistory.value = listDrainagePitHistory(dialog.form.泵坑编号)
  dialog.open = false
  reload()
}

onMounted(reload)
</script>
