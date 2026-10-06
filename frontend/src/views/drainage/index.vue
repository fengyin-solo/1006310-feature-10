<template>
  <section class="page" data-module="drainage">
    <header class="page-head">
      <div>
        <h2>廊内排水运维管理</h2>
        <p class="page-desc">泵坑编号、集水坑容积、当前水位、启泵水位一次落库；列表、详情与概览读同一份，刷新或返回再进仍是改过的版本。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记排水泵坑</button>
        <button class="btn" type="button" @click="exportRows">导出廊内排水运维清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in drainageCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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
          <td v-for="column in columns" :key="column">
            <template v-if="column === '泵坑编号'">
              <button class="link" type="button" @click="openDetail(row)">{{ row[column] }}</button>
              <span v-if="row['启泵水位补录']" class="tag-warn" title="早年台账缺启泵水位，已按 0.50m 补缺，待现场核实">补录</span>
            </template>
            <template v-else>{{ formatCell(row, column) }}</template>
          </td>
          <td>
            {{ row.status }}
            <span v-if="overStart(row)" class="tag-over">越线</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无廊内排水运维数据，可先登记排水泵坑</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊内排水运维记录 · 数据一次落库，刷新/退出再进仍是同一版</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
    </footer>

    <!-- 详情 / 编辑面板：与列表共用同一份台账 -->
    <div v-if="panelOpen" class="drawer-mask" @click.self="closePanel">
      <div class="drawer">
        <div class="drawer-head">
          <h3>{{ panelMode === 'create' ? '登记排水泵坑' : `泵坑详情 · ${form.泵坑编号 || ''}` }}</h3>
          <button class="btn ghost" type="button" @click="closePanel">关闭</button>
        </div>

        <div v-if="panelMode === 'detail' && activeRow" class="drawer-body">
          <dl class="detail-grid">
            <div v-for="field in detailFields" :key="field" class="detail-item">
              <dt>{{ field }}</dt>
              <dd>
                {{ formatCell(activeRow, field) }}
                <span v-if="field === '启泵水位' && activeRow['启泵水位补录']" class="tag-warn">系统按 0.50m 补缺，待核实</span>
              </dd>
            </div>
            <div class="detail-item">
              <dt>当前状态</dt>
              <dd>{{ activeRow.status }}</dd>
            </div>
          </dl>
          <p v-if="overStart(activeRow)" class="warn-text">当前水位已越过启泵线，应进入排水中。</p>
          <p v-if="formMessage" :class="formOk ? 'ok-text' : 'error-text'">{{ formMessage }}</p>
          <div class="drawer-actions">
            <button class="btn primary" type="button" @click="enterEdit">编辑取值</button>
            <button class="btn" type="button" @click="runAction('启动排水', activeRow)">启动排水</button>
            <button class="btn" type="button" @click="runAction('确认正常', activeRow)">确认正常</button>
            <button class="btn" type="button" @click="runAction('上报故障', activeRow)">上报故障</button>
          </div>

          <h4 class="history-title">变更历史（按原口径保留，只追加不回改）</h4>
          <ul v-if="history.length" class="history-list">
            <li v-for="event in history" :key="event.id">
              <span class="history-time">{{ event.time }}</span>
              <span class="history-action">{{ event.action }}</span>
              <span class="history-detail">{{ event.detail }}</span>
              <span class="history-operator">{{ event.operator }}</span>
            </li>
          </ul>
          <p v-else class="muted-text">暂无变更历史。</p>
        </div>

        <form v-else class="drawer-body" @submit.prevent="submitForm">
          <div class="form-grid">
            <label v-for="field in formFields" :key="field" class="form-item">
              <span>
                {{ field }}
                <i v-if="isRequired(field)" class="req">*</i>
              </span>
              <input
                v-model="form[field]"
                :type="field === '上次巡检日期' ? 'date' : field === '集水坑容积' || field === '当前水位' || field === '启泵水位' ? 'number' : 'text'"
                step="0.01"
                min="0"
                :placeholder="placeholderFor(field)"
              />
            </label>
          </div>
          <p class="muted-text">
            带 * 的泵坑编号、集水坑容积、当前水位、启泵水位为一次落库项，缺项须当场补齐；
            水位超过启泵线保存后自动进入排水中。
          </p>
          <div v-if="formMessage" :class="formOk ? 'ok-text' : 'error-text'">{{ formMessage }}</div>
          <div class="drawer-actions">
            <button class="btn primary" type="submit">{{ panelMode === 'create' ? '登记落库' : '保存覆盖' }}</button>
            <button v-if="panelMode === 'edit'" class="btn" type="button" @click="cancelEdit">返回详情</button>
          </div>
        </form>
      </div>
    </div>
  </section>
)
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createDrainageEntry,
  drainageHistory,
  downloadEntries,
  listEntries,
  loadOverview,
  moduleMeta,
  runAction as applyAction,
  saveDrainageEntry,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { DrainageDraft } from '@/api/local-service'
import type { EntryRow, HistoryEvent } from '@/data/types'

const meta = moduleMeta('drainage')
const session = useSessionStore()
// 列表口径：状态列（排水状态）由 status 统一承载，不重复展示；另带上上次巡检日期。
const columns = ['泵坑编号', '所属舱室', '集水坑容积', '当前水位', '启泵水位', '上次巡检日期', '排水泵编号', '值班人员']
const detailFields = [...columns]
const formFields: (keyof DrainageDraft)[] = ['泵坑编号', '所属舱室', '集水坑容积', '当前水位', '启泵水位', '上次巡检日期', '排水泵编号', '值班人员']
const requiredFields = new Set<keyof DrainageDraft>(['泵坑编号', '集水坑容积', '当前水位', '启泵水位'])
const actions = ['启动排水', '确认正常', '上报故障']
const statuses = ['待排水', '排水中', '水位正常', '水泵故障']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['泵坑编号', '所属舱室', '排水泵编号']

const drainageCards = ref<{ label: string; value: number }[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const panelOpen = ref(false)
const panelMode = ref<'detail' | 'edit' | 'create'>('detail')
const activeId = ref<number | null>(null)
const activeRow = ref<EntryRow | null>(null)
const history = ref<HistoryEvent[]>([])
const formMessage = ref('')
const formOk = ref(false)

const emptyForm = (): DrainageDraft => ({
  泵坑编号: '',
  所属舱室: '',
  集水坑容积: '',
  当前水位: '',
  启泵水位: '',
  上次巡检日期: '',
  排水泵编号: '',
  值班人员: '',
})
const form = reactive<DrainageDraft>(emptyForm())

function overStart(row: EntryRow | null): boolean {
  if (!row) {
    return false
  }
  const current = Number(row['当前水位'])
  const start = Number(row['启泵水位'])
  return Number.isFinite(current) && Number.isFinite(start) && current > start
}

function formatCell(row: EntryRow, field: string): string {
  const value = row[field]
  if (value === undefined || value === null || String(value) === '') {
    return field === '上次巡检日期' ? '待补录' : '—'
  }
  return String(value)
}

function isRequired(field: keyof DrainageDraft): boolean {
  return requiredFields.has(field)
}

function placeholderFor(field: keyof DrainageDraft): string {
  if (field === '集水坑容积') {
    return '立方米'
  }
  if (field === '当前水位' || field === '启泵水位') {
    return '米'
  }
  return `请填写${field}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function loadCards() {
  drainageCards.value = loadOverview().drainage
}

function reload() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    loadCards()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊内排水运维列表读取失败'
  }
}

function fillFormFromRow(row: EntryRow) {
  for (const field of formFields) {
    const value = row[field]
    form[field] = value === undefined || value === null ? '' : String(value)
  }
}

function openDetail(row: EntryRow) {
  panelMode.value = 'detail'
  activeId.value = Number(row.id)
  activeRow.value = row
  history.value = drainageHistory(Number(row.id))
  fillFormFromRow(row)
  formMessage.value = ''
  formOk.value = false
  panelOpen.value = true
}

function enterEdit() {
  if (activeRow.value) {
    fillFormFromRow(activeRow.value)
  }
  panelMode.value = 'edit'
  formMessage.value = ''
}

function cancelEdit() {
  panelMode.value = 'detail'
  if (activeRow.value) {
    fillFormFromRow(activeRow.value)
  }
}

function openCreate() {
  Object.assign(form, emptyForm())
  activeId.value = null
  activeRow.value = null
  history.value = []
  panelMode.value = 'create'
  formMessage.value = ''
  formOk.value = false
  panelOpen.value = true
}

function closePanel() {
  panelOpen.value = false
}

function submitForm() {
  formMessage.value = ''
  const operator = session.operator
  const result = panelMode.value === 'create'
    ? createDrainageEntry({ ...form }, operator)
    : saveDrainageEntry(activeId.value as number, { ...form }, operator)
  formOk.value = result.ok
  if (!result.ok) {
    formMessage.value = result.message
    return
  }
  formMessage.value = result.message
  reload()
  if (panelMode.value === 'create') {
    // 登记成功后回到列表，新值即在列表中；再次进入看到的就是落库版本。
    panelOpen.value = false
    return
  }
  const saved = listEntries(meta.key).items.find((item) => Number(item.id) === activeId.value) ?? null
  activeRow.value = saved
  if (saved) {
    history.value = drainageHistory(Number(saved.id))
  }
  panelMode.value = 'detail'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, session.operator)
  reload()
  if (!result.ok) {
    errorMessage.value = result.message
    if (panelOpen.value) {
      formMessage.value = result.message
      formOk.value = false
    }
    return
  }
  noticeMessage.value = result.message
  if (panelOpen.value) {
    formMessage.value = result.message
    formOk.value = true
  }
  if (panelOpen.value && Number(row.id) === activeId.value) {
    const saved = listEntries(meta.key).items.find((item) => Number(item.id) === row.id) ?? null
    activeRow.value = saved
    if (saved) {
      history.value = drainageHistory(Number(saved.id))
    }
  }
}

onMounted(reload)
</script>

<style scoped>
.tag-warn {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  font-size: 11px;
  font-style: normal;
}
.tag-over {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: #fee2e2;
  color: #b42318;
  font-size: 11px;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}
.drawer {
  width: 640px;
  max-width: 92vw;
  height: 100%;
  background: #fff;
  display: flex;
  flex-direction: column;
  box-shadow: -8px 0 24px rgba(15, 23, 42, 0.2);
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.drawer-head h3 { margin: 0; font-size: 16px; }
.drawer-body { padding: 16px 18px; overflow-y: auto; }
.drawer-actions { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; margin: 0; }
.detail-item { margin: 0; }
.detail-item dt { font-size: 12px; color: var(--muted); }
.detail-item dd { margin: 2px 0 0; font-size: 14px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; }
.form-item span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.form-item input { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.req { color: #b42318; font-style: normal; margin-left: 2px; }
.warn-text { color: #b42318; font-size: 13px; }
.ok-text { color: #15803d; font-size: 13px; }
.muted-text { color: var(--muted); font-size: 12px; }
.history-title { margin: 18px 0 8px; font-size: 14px; }
.history-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.history-list li {
  border-left: 3px solid var(--brand);
  background: #f8fafc;
  padding: 6px 10px;
  font-size: 12px;
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 2px 10px;
}
.history-time { color: var(--muted); grid-row: span 2; }
.history-action { font-weight: 600; }
.history-detail { grid-column: 2 / 4; color: #334155; }
.history-operator { color: var(--muted); }
</style>
