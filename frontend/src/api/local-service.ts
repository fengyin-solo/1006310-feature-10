import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  getState,
  listHistory,
  listRows,
  listTodos,
  resetRows,
  saveRows,
  updateState,
  withHistory,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  HistoryEvent,
  ModuleMeta,
  OverviewResult,
  PageResult,
  TodoItem,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const DRAINAGE_KEY = 'drainage'
const DUTY_KEY = 'duty'
// 一次落库的四项关键取值：编号、容积、当前水位、启泵水位，缺一项都不收。
const DRAINAGE_REQUIRED = ['泵坑编号', '集水坑容积', '当前水位', '启泵水位'] as const
const DRAINAGE_NUMBERS = ['集水坑容积', '当前水位', '启泵水位'] as const
const DRAINAGE_STATUS: Record<string, { pending: boolean; abnormal: boolean }> = {
  待排水: { pending: true, abnormal: false },
  排水中: { pending: true, abnormal: false },
  水位正常: { pending: false, abnormal: false },
  水泵故障: { pending: false, abnormal: true },
}

export type DrainageDraft = {
  泵坑编号: string
  所属舱室: string
  集水坑容积: string
  当前水位: string
  启泵水位: string
  上次巡检日期: string
  排水泵编号: string
  值班人员: string
}

export type DrainageSaveResult =
  | { ok: true; message: string; row: EntryRow }
  | { ok: false; message: string }

export type ReconcileResult = {
  dutyTotal: number
  todoTotal: number
  openTodos: number
  legacyTodos: number
  matched: boolean
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function drainageStatus(level: { '当前水位': number; '启泵水位': number }): string {
  // 当前水位越过启泵线就进排水中；回到启泵线及以下即水位正常。
  return level['当前水位'] > level['启泵水位'] ? '排水中' : '水位正常'
}

type DrainageValues = Record<string, string | number | boolean>

function normalizeDraft(draft: DrainageDraft): { values: DrainageValues | null; message: string } {
  const values: DrainageValues = {
    泵坑编号: draft.泵坑编号.trim(),
    所属舱室: draft.所属舱室.trim(),
    上次巡检日期: draft.上次巡检日期.trim(),
    排水泵编号: draft.排水泵编号.trim(),
    值班人员: draft.值班人员.trim(),
  }
  for (const field of DRAINAGE_REQUIRED) {
    if (!String(draft[field]).trim()) {
      return { values: null, message: `「${field}」缺项，泵坑编号、集水坑容积、当前水位、启泵水位须一次补齐落库` }
    }
  }
  for (const field of DRAINAGE_NUMBERS) {
    const parsed = Number(String(draft[field]).trim())
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { values: null, message: `「${field}」须为不小于 0 的数值（米/立方米）` }
    }
    values[field] = parsed
  }
  if (Number(values['集水坑容积']) === 0) {
    return { values: null, message: '集水坑容积须大于 0' }
  }
  return { values, message: '' }
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function nextId(items: { id: number }[]): number {
  return items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
}

/** 登记新泵坑：四项关键取值 + 其余缺项一次补齐，状态按水位自动判定。 */
export function createDrainageEntry(draft: DrainageDraft, operator = '值班管理员'): DrainageSaveResult {
  const normalized = normalizeDraft(draft)
  if (!normalized.values) {
    return { ok: false, message: normalized.message }
  }
  try {
    let saved: EntryRow | null = null
    updateState((state) => {
      const rows = state.rows[DRAINAGE_KEY] ?? []
      const code = String(normalized.values!['泵坑编号'])
      if (rows.some((row) => String(row['泵坑编号']) === code)) {
        throw new Error(`泵坑编号 ${code} 已存在，不能重复登记`)
      }
      const values = normalized.values!
      const status = drainageStatus({ '当前水位': Number(values['当前水位']), '启泵水位': Number(values['启泵水位']) })
      const flag = DRAINAGE_STATUS[status]
      const row: EntryRow = {
        id: nextId(rows),
        status,
        pending: flag.pending,
        abnormal: flag.abnormal,
        排水状态: status,
        ...values,
      }
      const rowsNext = [...rows, row]
      let next: ReturnType<typeof getState> = { ...state, rows: { ...state.rows, [DRAINAGE_KEY]: rowsNext } }
      next = withHistory(next, {
        module: DRAINAGE_KEY,
        refId: row.id,
        refLabel: code,
        action: '登记排水泵坑',
        detail: `泵坑编号、集水坑容积、当前水位、启泵水位一次落库；当前水位 ${row['当前水位']}m / 启泵水位 ${row['启泵水位']}m，状态判为「${status}」`,
        operator,
      })
      saved = row
      return next
    })
    return {
      ok: true,
      message: `泵坑 ${saved!['泵坑编号']} 已登记落库，当前状态「${saved!.status}」`,
      row: saved!,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '泵坑登记失败' }
  }
}

/**
 * 保存泵坑编辑（覆盖当前台账，历史另存）：
 * - 四项关键取值一次落库，缺项当场补齐才收；
 * - 当前水位越过启泵线自动进排水中，回到线以下自动为水位正常；
 * - 曾被系统补缺的启泵水位，人工保存后视为已核实，撤下补录标记。
 */
export function saveDrainageEntry(id: number, draft: DrainageDraft, operator = '值班管理员'): DrainageSaveResult {
  const normalized = normalizeDraft(draft)
  if (!normalized.values) {
    return { ok: false, message: normalized.message }
  }
  try {
    let saved: EntryRow | null = null
    updateState((state) => {
      const rows = state.rows[DRAINAGE_KEY] ?? []
      const index = rows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        throw new Error(`没有找到编号为 ${id} 的排水泵坑`)
      }
      const code = String(normalized.values!['泵坑编号'])
      if (rows.some((row) => Number(row.id) !== id && String(row['泵坑编号']) === code)) {
        throw new Error(`泵坑编号 ${code} 已被其他泵坑占用`)
      }
      const before = rows[index]
      const values = normalized.values!
      const status = drainageStatus({ '当前水位': Number(values['当前水位']), '启泵水位': Number(values['启泵水位']) })
      const flag = DRAINAGE_STATUS[status]
      const wasBackfilled = before['启泵水位补录'] === true
      const row: EntryRow = {
        ...before,
        ...values,
        status,
        pending: flag.pending,
        abnormal: flag.abnormal,
        排水状态: status,
      }
      if (wasBackfilled) {
        delete row['启泵水位补录']
      }
      const changed: string[] = []
      for (const field of ['集水坑容积', '当前水位', '启泵水位', '上次巡检日期', '所属舱室', '排水泵编号', '值班人员']) {
        if (String(before[field] ?? '') !== String(row[field] ?? '')) {
          changed.push(`${field}: ${before[field] ?? '空'} → ${row[field] ?? '空'}`)
        }
      }
      if (String(before.status) !== status) {
        changed.push(`状态: ${before.status} → ${status}`)
      }
      const rowsNext = [...rows]
      rowsNext[index] = row
      let next: ReturnType<typeof getState> = { ...state, rows: { ...state.rows, [DRAINAGE_KEY]: rowsNext } }
      next = withHistory(next, {
        module: DRAINAGE_KEY,
        refId: id,
        refLabel: code,
        action: wasBackfilled ? '补录核实并保存' : '编辑保存',
        detail: changed.length
          ? changed.join('；')
          : '内容无变化，台账原值保留',
        operator,
      })
      saved = row
      return next
    })
    return { ok: true, message: `泵坑 ${saved!['泵坑编号']} 已保存，列表、详情与概览读到的是同一份`, row: saved! }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '泵坑保存失败' }
  }
}

export function drainageHistory(id: number): HistoryEvent[] {
  return listHistory(DRAINAGE_KEY, id)
}

/** 排水泵坑动作：启泵、确认正常、故障。确认正常幂等，同一泵坑重复确认只回落一次。 */
function runDrainageAction(id: number, action: string, operator: string): ActionResult {
  try {
    let message = ''
    updateState((state) => {
      const rows = state.rows[DRAINAGE_KEY] ?? []
      const index = rows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        throw new Error(`没有找到编号为 ${id} 的排水泵坑`)
      }
      const row = rows[index]
      const code = String(row['泵坑编号'] ?? `#${id}`)
      const current = String(row.status)

      if (action === '启动排水') {
        if (Number(row['当前水位']) <= Number(row['启泵水位'])) {
          throw new Error(`${code} 当前水位未越过启泵线（${row['当前水位'] ?? '—'}m / ${row['启泵水位'] ?? '—'}m），无需启动排水`)
        }
        if (current === '排水中') {
          message = `${code} 已在排水中，不重复登记`
          return state
        }
        const rowsNext = [...rows]
        rowsNext[index] = { ...row, status: '排水中', pending: true, abnormal: false, 排水状态: '排水中' }
        message = `${code} 已启动排水，状态「排水中」`
        return withHistory(
          { ...state, rows: { ...state.rows, [DRAINAGE_KEY]: rowsNext } },
          { module: DRAINAGE_KEY, refId: id, refLabel: code, action, detail: '水位越过启泵线，人工启动排水', operator },
        )
      }

      if (action === '确认正常') {
        // 幂等：已确认过的泵坑再次确认不再回落、不写历史，待排水数只认第一次。
        if (current === '水位正常') {
          message = `${code} 已确认过水位正常，待排水计数不重复回落`
          return state
        }
        if (Number(row['当前水位']) > Number(row['启泵水位'])) {
          throw new Error(`${code} 当前水位仍高于启泵线，不能确认正常`)
        }
        const rowsNext = [...rows]
        rowsNext[index] = { ...row, status: '水位正常', pending: false, abnormal: false, 排水状态: '水位正常' }
        message = `${code} 水位确认正常，概览待排水泵坑数已回落`
        return withHistory(
          { ...state, rows: { ...state.rows, [DRAINAGE_KEY]: rowsNext } },
          { module: DRAINAGE_KEY, refId: id, refLabel: code, action, detail: `确认时水位 ${row['当前水位']}m，不高于启泵水位 ${row['启泵水位']}m，待排水计数回落一次`, operator },
        )
      }

      if (action === '上报故障') {
        if (current === '水泵故障') {
          message = `${code} 已登记水泵故障，不重复上报`
          return state
        }
        const rowsNext = [...rows]
        rowsNext[index] = { ...row, status: '水泵故障', pending: false, abnormal: true, 排水状态: '水泵故障' }
        message = `${code} 已上报水泵故障，移出待排水计数`
        return withHistory(
          { ...state, rows: { ...state.rows, [DRAINAGE_KEY]: rowsNext } },
          { module: DRAINAGE_KEY, refId: id, refLabel: code, action, detail: '水泵故障，待排水计数不再计入', operator },
        )
      }

      throw new Error(`排水泵坑没有登记「${action}」这个动作`)
    })
    return { ok: true, message }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '排水操作失败' }
  }
}

/** 按值班台账重建待办：一条交接记录对应一条待办，台账怎么变待办就怎么变。 */
function reconcileTodos(state: ReturnType<typeof getState>): ReturnType<typeof getState> {
  const duty = state.rows[DUTY_KEY] ?? []
  const previous = new Map(state.todos.map((item) => [item.sourceId, item]))
  const time = nowText()
  let idCursor = state.todos.reduce((max, item) => Math.max(max, item.id), 0)
  const todos: TodoItem[] = duty.map((row) => {
    const status = String(row.status)
    const todoStatus: TodoItem['status'] = status === '已交接' ? '已办' : status === '有遗留' ? '遗留' : '待办'
    const sourceId = Number(row.id)
    const old = previous.get(sourceId)
    if (!old) {
      idCursor += 1
    }
    return {
      id: old?.id ?? idCursor,
      title: `${row['值班日期'] || '日期待补'} ${row['班次'] || '班次待补'} 值班交接`,
      shift: String(row['班次'] ?? ''),
      date: String(row['值班日期'] ?? ''),
      status: todoStatus,
      sourceId,
      createdAt: old?.createdAt ?? time,
      doneAt: todoStatus === '已办' ? (old?.doneAt || time) : '',
    }
  })
  return { ...state, todos }
}

/** 值班动作：状态流转同时同步待办清单，并留一条交接历史。 */
function runDutyAction(id: number, action: string, operator: string): ActionResult {
  const meta = moduleMeta(DUTY_KEY)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  try {
    let message = ''
    updateState((state) => {
      const rows = state.rows[DUTY_KEY] ?? []
      const index = rows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        throw new Error(`没有找到编号为 ${id} 的${meta.entity}`)
      }
      const row = rows[index]
      const code = String(row['交接编号'] ?? `#${id}`)
      if (String(row.status) === target) {
        message = `${code} 已经是「${target}」，不重复操作`
        return state
      }
      const rowsNext = [...rows]
      rowsNext[index] = {
        ...row,
        status: target,
        pending: target !== '已交接',
        abnormal: false,
        交接状态: target,
      }
      let next = reconcileTodos({ ...state, rows: { ...state.rows, [DUTY_KEY]: rowsNext } })
      next = withHistory(next, {
        module: DUTY_KEY,
        refId: id,
        refLabel: code,
        action,
        detail: `值班台账状态 → 「${target}」，待办清单同步更新`,
        operator,
      })
      message = `${code} 已${action}，台账与待办同步为「${target}」`
      return next
    })
    return { ok: true, message }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '值班交接操作失败' }
  }
}

export function runAction(key: string, id: number, action: string, operator = '值班管理员'): ActionResult {
  if (key === DRAINAGE_KEY) {
    return runDrainageAction(id, action, operator)
  }
  if (key === DUTY_KEY) {
    return runDutyAction(id, action, operator)
  }

  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${meta.entity}状态保存失败，请重试`,
    }
  }
}

export function listDutyTodos(): TodoItem[] {
  return listTodos()
}

/** 对账：以待办清单与值班台账条数对得上为准，返回对账结论；任何偏差都以台账为准重算。 */
export function reconcileDutyTodos(): ReconcileResult {
  const state = reconcileTodos(getState())
  updateState(() => state)
  const duty = state.rows[DUTY_KEY] ?? []
  const open = state.todos.filter((item) => item.status !== '已办').length
  const legacy = state.todos.filter((item) => item.status === '遗留').length
  return {
    dutyTotal: duty.length,
    todoTotal: state.todos.length,
    openTodos: open,
    legacyTodos: legacy,
    matched: duty.length === state.todos.length,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const state = getState()
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const drainage = rows[DRAINAGE_KEY] ?? []
  const countBy = (status: string) => drainage.filter((row) => String(row.status) === status).length
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return {
    cards,
    modules,
    // 待排水口径：待排水 + 排水中；确认正常回落一次，故障不计入。
    drainage: [
      { label: '待排水泵坑', value: countBy('待排水') + countBy('排水中') },
      { label: '排水中泵坑', value: countBy('排水中') },
      { label: '水位正常泵坑', value: countBy('水位正常') },
      { label: '水泵故障数', value: countBy('水泵故障') },
    ],
  }
}
