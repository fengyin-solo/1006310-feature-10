import { MODULE_BY_KEY } from '@/data/modules'
import {
  DRAINAGE_ACTIONS,
  DRAINAGE_KEY,
  DRAINAGE_STATUS,
  BACKFILL_BLANK,
  BACKFILL_SUPPLEMENTED,
  BLANK_LEVEL_LABEL,
  PIT_EDITABLE_FIELDS,
  asPits,
  buildHistoryEvent,
  deriveStatus,
  isOpenPit,
  migrateOpenPitsToLedger,
  nextShiftLabel,
  parseLevel,
  reconcileDrainage,
  drainageStats,
  type EditableField,
  type LedgerBrief,
} from '@/data/drainage'
import {
  allRows,
  commit,
  listDrainageHistory,
  listRows,
  resetRows,
} from '@/data/local-store'
import type {
  ActionResult,
  ActorContext,
  DrainageHistoryEntry,
  DrainagePit,
  DrainageReconcileReport,
  DrainageTodo,
  DrainageView,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const DEFAULT_ACTOR: ActorContext = { operator: '值班管理员', shift: '白班 08:00-20:00' }

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

function dutyLedgersOf(entries: Record<string, EntryRow[]>): LedgerBrief[] {
  return (entries['duty'] ?? [])
    .map((row) => ({
      交接编号: String(row['交接编号'] ?? ''),
      值班日期: String(row['值班日期'] ?? ''),
      班次: String(row['班次'] ?? ''),
    }))
    .filter((ledger) => ledger.交接编号)
}

function currentLedger(entries: Record<string, EntryRow[]>): EntryRow | null {
  const open = (entries['duty'] ?? []).find((row) => String(row.status) === '交接中')
  return open ?? null
}

function appendHistory(history: DrainageHistoryEntry[], pit: DrainagePit, action: string, note: string, actor: ActorContext): void {
  const seq = history.reduce((max, item) => Math.max(max, item.id), 0) + 1
  history.push(buildHistoryEvent(seq, pit, action, note, actor))
}

/** 落库后统一跑一次对账：待办与台账始终同步，页面不需要各自判断。 */
function commitDrainage(
  pits: DrainagePit[],
  history: DrainageHistoryEntry[],
): { report: DrainageReconcileReport; todos: DrainageTodo[] } {
  let report!: DrainageReconcileReport
  let todos: DrainageTodo[] = []
  commit((state) => {
    state.entries[DRAINAGE_KEY] = pits
    state.drainageHistory = history
    const ledgers = dutyLedgersOf(state.entries)
    const result = reconcileDrainage(asPits(state.entries[DRAINAGE_KEY]), ledgers, '', '')
    report = result.report
    todos = result.todos
  })
  return { report, todos }
}

export function runAction(key: string, id: number, action: string): ActionResult {
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
  commit((state) => {
    state.entries[key] = next
  })
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
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
    lines.push([
      row.id,
      ...meta.fields.map((field) => {
        const value = row[field]
        // 启泵水位显式留空在导出里也显式标注，不允许导出成空白数字
        if (key === DRAINAGE_KEY && field === '启泵水位' && (value === '' || value === undefined || value === null)) {
          return BLANK_LEVEL_LABEL
        }
        return value ?? ''
      }),
      row.status,
    ].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

/* ------------------------------------------------------------------ */
/* 廊内排水运维：取值口径收口在这一段，页面只渲染、不做业务判断            */
/* ------------------------------------------------------------------ */

export type PitDraft = Partial<Record<EditableField, string>>

export type DrainageSaveResult = ActionResult & {
  pit?: DrainagePit
  report?: DrainageReconcileReport
}

function validateDraft(draft: PitDraft, pits: DrainagePit[], selfId: number | null): string | null {
  for (const field of PIT_EDITABLE_FIELDS) {
    const value = draft[field]
    if (field === '启泵水位') {
      // 显式留空只允许出现在存量迁移（补录标记已注明）；值班员补录/新登记必须给值。
      if (selfId === null) {
        if (!value || !value.trim()) return '启泵水位必须填写，新登记泵坑不允许留空'
      }
      continue
    }
    if (!value || !value.trim()) return `${field}不能为空，补录时缺项要一并补齐`
  }
  const code = draft['泵坑编号']!.trim()
  const duplicated = pits.some((pit) => pit.泵坑编号 === code && pit.id !== selfId)
  if (duplicated) return `泵坑编号 ${code} 已存在，编号全舱唯一，不能覆盖到别的泵坑`
  const volume = Number(draft['集水坑容积']!.trim())
  if (!Number.isFinite(volume) || volume <= 0) return '集水坑容积必须是大于 0 的数字（m³）'
  const current = Number(draft['当前水位']!.trim())
  if (!Number.isFinite(current) || current < 0) return '当前水位必须是不小于 0 的数字（m）'
  if (draft['启泵水位'] && draft['启泵水位'].trim() !== '') {
    const threshold = Number(draft['启泵水位'].trim())
    if (!Number.isFinite(threshold) || threshold <= 0) return '启泵水位必须是大于 0 的数字（m）'
  }
  return null
}

/**
 * 保存泵坑（覆盖口径，不另存新版本）：泵坑编号、集水坑容积、当前水位、启泵水位一次落库。
 * 水位越过启泵线自动进排水中；补录启泵水位后「待核定」待办自动核销。
 */
export function saveDrainagePit(
  id: number,
  draft: PitDraft,
  actor: ActorContext = DEFAULT_ACTOR,
): DrainageSaveResult {
  try {
    const state = allRows()
    const pits = asPits(state[DRAINAGE_KEY] ?? []).map((pit) => ({ ...pit }))
    const index = pits.findIndex((pit) => pit.id === id)
    if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的排水泵坑` }
    const before = pits[index]
    const error = validateDraft(draft, pits, id)
    if (error) return { ok: false, message: error }

    const changes: string[] = []
    for (const field of PIT_EDITABLE_FIELDS) {
      const value = (draft[field] ?? '').trim()
      const oldDisplay = field === '启泵水位' && before[field] === '' ? BLANK_LEVEL_LABEL : before[field]
      if (field === '启泵水位' && value === '' && before.补录标记 === BACKFILL_BLANK) {
        // 允许在详情里保持留空，但不改变待核定状态
      } else if (String(before[field]) !== value) {
        changes.push(`${field}：${oldDisplay} → ${value || BLANK_LEVEL_LABEL}`)
        ;(before[field] as string) = value
      }
    }

    const supplemented = before.补录标记 === BACKFILL_BLANK && before.启泵水位.trim() !== ''
    if (supplemented) before.补录标记 = BACKFILL_SUPPLEMENTED
    before.status = deriveStatus(before.当前水位, before.启泵水位)
    before.pending = isOpenPit(before)
    before.abnormal = before.status === DRAINAGE_STATUS.fault
    before.排水状态 = before.status

    const history = [...listDrainageHistory()]
    if (changes.length === 0) {
      // 无修改也要把对账口径跑一遍，但不产生新历史
    } else {
      const action = supplemented ? '补录启泵水位' : '修改泵坑参数'
      appendHistory(history, before, action, `${changes.join('；')}`, actor)
    }
    if (supplemented) {
      const note = `补录完成：启泵水位核定为 ${before.启泵水位} m，待核定待办核销，状态按水位口径落为「${before.status}」`
      appendHistory(history, before, '补录归档', note, actor)
    }

    const { report } = commitDrainage(pits, history)
    return { ok: true, message: `泵坑 ${before.泵坑编号} 已覆盖落库（不另存新版本），状态「${before.status}」。${report.message}`, pit: before, report }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '泵坑保存失败，请重试' }
  }
}

/** 登记新泵坑：缺项一并校验，挂当前交接班次，随后立即对账。 */
export function registerDrainagePit(
  draft: Required<Pick<PitDraft, EditableField>> & { 所属舱室: string },
  actor: ActorContext = DEFAULT_ACTOR,
): DrainageSaveResult {
  try {
    const entries = allRows()
    const pits = asPits(entries[DRAINAGE_KEY] ?? []).map((pit) => ({ ...pit }))
    const error = validateDraft(draft, pits, null)
    if (error) return { ok: false, message: error }
    const ledger = currentLedger(entries)
    const id = pits.reduce((max, pit) => Math.max(max, pit.id), 0) + 1
    const code = draft['泵坑编号']!.trim()
    const pit: DrainagePit = {
      id,
      status: DRAINAGE_STATUS.pending,
      pending: true,
      abnormal: false,
      泵坑编号: code,
      所属舱室: draft.所属舱室.trim(),
      集水坑容积: draft['集水坑容积']!.trim(),
      当前水位: draft['当前水位']!.trim(),
      启泵水位: draft['启泵水位']!.trim(),
      排水泵编号: `PUMP-NEW-${String(id).padStart(2, '0')}`,
      值班人员: actor.operator,
      排水状态: DRAINAGE_STATUS.pending,
      上次巡检日期: new Date().toISOString().slice(0, 10),
      值班台账: ledger ? String(ledger['交接编号']) : '',
      交接班次: ledger ? `${String(ledger['值班日期'])} ${String(ledger['班次'])}` : '',
      补录标记: '',
    }
    pit.status = deriveStatus(pit.当前水位, pit.启泵水位)
    pit.pending = isOpenPit(pit)
    pit.排水状态 = pit.status
    pits.push(pit)
    const history = [...listDrainageHistory()]
    appendHistory(history, pit, '登记泵坑', `新登记泵坑，集水坑容积 ${pit.集水坑容积} m³，启泵水位 ${pit.启泵水位} m，状态「${pit.status}」`, actor)
    const { report } = commitDrainage(pits, history)
    return { ok: true, message: `泵坑 ${code} 已登记落库，状态「${pit.status}」。${report.message}`, pit, report }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '泵坑登记失败，请重试' }
  }
}

/**
 * 排水动作（带业务闸口）：
 * 启动排水只在待排水可用；确认正常只在排水中可用，重复点不回落第二次；
 * 上报故障后只保留故障口径。
 */
export function runDrainageAction(
  id: number,
  action: string,
  actor: ActorContext = DEFAULT_ACTOR,
): ActionResult {
  try {
    const state = allRows()
    const pits = asPits(state[DRAINAGE_KEY] ?? []).map((pit) => ({ ...pit }))
    const index = pits.findIndex((pit) => pit.id === id)
    if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的排水泵坑` }
    const pit = pits[index]

    if (action === DRAINAGE_ACTIONS.start) {
      if (parseLevel(pit.启泵水位) === null) return { ok: false, message: `${pit.泵坑编号} 启泵水位待核定，先补录再启动排水` }
      if (pit.status === DRAINAGE_STATUS.fault) return { ok: false, message: `${pit.泵坑编号} 水泵故障，先检修，不能启动排水` }
      if (pit.status === DRAINAGE_STATUS.draining) return { ok: false, message: `${pit.泵坑编号} 已在排水中，不用重复启动` }
      if (pit.status === DRAINAGE_STATUS.normal) {
        // 只有水位确实越过启泵线才允许进排水中，动作口径与对账口径一致
        const next = deriveStatus(pit.当前水位, pit.启泵水位)
        if (next !== DRAINAGE_STATUS.draining) return { ok: false, message: `${pit.泵坑编号} 当前水位未越过启泵线，无需启动排水` }
      }
      pit.status = DRAINAGE_STATUS.draining
      pit.pending = true
      pit.abnormal = false
    } else if (action === DRAINAGE_ACTIONS.confirmNormal) {
      if (pit.status === DRAINAGE_STATUS.normal) return { ok: false, message: `${pit.泵坑编号} 已确认正常，重复确认不会再次回落待排水数` }
      if (pit.status === DRAINAGE_STATUS.fault) return { ok: false, message: `${pit.泵坑编号} 水泵故障未恢复，不能确认正常` }
      if (pit.status !== DRAINAGE_STATUS.draining) return { ok: false, message: `${pit.泵坑编号} 不在排水中，先启动排水再确认` }
      pit.status = DRAINAGE_STATUS.normal
      pit.pending = false
      pit.abnormal = false
    } else if (action === DRAINAGE_ACTIONS.fault) {
      if (pit.status === DRAINAGE_STATUS.fault) return { ok: false, message: `${pit.泵坑编号} 已上报水泵故障，待办只挂一条` }
      pit.status = DRAINAGE_STATUS.fault
      pit.pending = false
      pit.abnormal = true
    } else {
      return { ok: false, message: `排水泵坑没有登记「${action}」这个动作` }
    }
    pit.排水状态 = pit.status

    const history = [...listDrainageHistory()]
    appendHistory(history, pit, action, `状态流转为「${pit.status}」`, actor)
    const { report } = commitDrainage(pits, history)
    return { ok: true, message: `${pit.泵坑编号} 已${action}，当前状态「${pit.status}」。${report.message}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '排水操作失败，请重试' }
  }
}

export function loadDrainage(): DrainageView {
  const pits = asPits(listRows(DRAINAGE_KEY))
  const history = listDrainageHistory()
  const ledgers = dutyLedgersOf(allRows())
  // 读路径上只校准不落库；校准结果随下一次写操作一起落库，避免读页面产生写失败。
  const working = pits.map((pit) => ({ ...pit }))
  const result = reconcileDrainage(working, ledgers, '', '')
  return { pits: working, stats: drainageStats(working), todos: result.todos, report: result.report, history }
}

/** 手动对账：把校准结果落库，页面提示待办条数与值班台账对账结论。 */
export function runDrainageReconcile(actor: ActorContext = DEFAULT_ACTOR): DrainageView {
  const pits = asPits(listRows(DRAINAGE_KEY)).map((pit) => ({ ...pit }))
  const history = [...listDrainageHistory()]
  const ledgers = dutyLedgersOf(allRows())
  const result = reconcileDrainage(pits, ledgers, '', '')
  for (const calibrated of result.calibrated) {
    appendHistory(history, calibrated.pit, '对账校准', calibrated.note, actor)
  }
  commitDrainage(pits, history)
  return loadDrainage()
}

export function listDrainagePitHistory(code: string): DrainageHistoryEntry[] {
  return listDrainageHistory()
    .filter((item) => item.泵坑编号 === code)
    .sort((a, b) => b.时间.localeCompare(a.时间) || b.id - a.id)
}

/* ------------------------------------------------------------------ */
/* 运维值班交接：存量台账按交接班次迁移，待办清单随台账同步变化            */
/* ------------------------------------------------------------------ */

export type DutyHandoverResult = ActionResult & {
  nextLedger?: EntryRow
  migratedPitCodes?: string[]
}

/**
 * 确认交接：当前「交接中」台账关闭为「已交接」，自动开下一班台账；
 * 未闭环（待排水/排水中）泵坑连同待办迁到下一班，已闭环的留在原班次。
 */
export function confirmDutyHandover(
  ledgerId: number,
  actor: ActorContext = DEFAULT_ACTOR,
): DutyHandoverResult {
  try {
    const entries = allRows()
    const dutyRows = [...(entries['duty'] ?? [])]
    const index = dutyRows.findIndex((row) => Number(row.id) === ledgerId)
    if (index < 0) return { ok: false, message: `没有找到编号为 ${ledgerId} 的值班台账` }
    const ledger = dutyRows[index]
    if (String(ledger.status) !== '交接中') {
      return { ok: false, message: `台账 ${String(ledger['交接编号'])} 已不是交接中，不能重复交接（待办不会二次迁移）` }
    }

    const next = nextShiftLabel(String(ledger['班次'] ?? ''), String(ledger['值班日期'] ?? ''))
    const newId = dutyRows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
    const seqNo = newId
    const newCode = `DUTY-${String(seqNo).padStart(4, '0')}`
    const nextLedger: EntryRow = {
      id: newId,
      status: '交接中',
      pending: true,
      abnormal: false,
      交接编号: newCode,
      值班班组: String(ledger['值班班组'] ?? ''),
      值班日期: next.date,
      班次: next.shift,
      值班人员: actor.operator,
      交接事项: '上一班交接，跟进未闭环排水泵坑',
      交接人员: '',
      交接状态: '交接中',
    }
    const closed: EntryRow = {
      ...ledger,
      status: '已交接',
      pending: false,
      交接人员: actor.operator,
      交接状态: '已交接',
    }
    dutyRows[index] = closed
    dutyRows.push(nextLedger)

    const pits = asPits(entries[DRAINAGE_KEY] ?? []).map((pit) => ({ ...pit }))
    const fromCode = String(ledger['交接编号'])
    const migrated = pits.filter((pit) => pit.值班台账 === fromCode && isOpenPit(pit))
    const nextBrief = { 交接编号: newCode, 班次: `${next.date} ${next.shift}` }
    const migratedPits = migrateOpenPitsToLedger(pits, fromCode, nextBrief)

    const history = [...listDrainageHistory()]
    appendHistory(
      history,
      { 泵坑编号: fromCode } as DrainagePit,
      '班次交接',
      `台账 ${fromCode} 关闭，下一班 ${newCode}（${nextBrief.班次}）接岗`,
      actor,
    )
    for (const pit of migrated) {
      appendHistory(
        history,
        pit,
        '班次交接',
        `未闭环泵坑随班迁移：${fromCode} → ${newCode}`,
        actor,
      )
    }

    let report!: DrainageReconcileReport
    let todos: DrainageTodo[] = []
    commit((state) => {
      state.entries['duty'] = dutyRows
      state.entries[DRAINAGE_KEY] = migratedPits
      state.drainageHistory = history
      const result = reconcileDrainage(asPits(state.entries[DRAINAGE_KEY]), dutyLedgersOf(state.entries), '', '')
      report = result.report
      todos = result.todos
    })

    const migratedText = migrated.length ? `，迁出未闭环泵坑 ${migrated.length} 个` : ''
    const ledgerTodos = report.todoCountByLedger.find((item) => item.交接编号 === newCode)?.待办数 ?? 0
    return {
      ok: true,
      message: `交接完成：${fromCode} 已关闭，${newCode} 接岗${migratedText}，本班待办 ${ledgerTodos} 条（待办清单已随台账同步）。${report.message}`,
      nextLedger,
      migratedPitCodes: migrated.map((pit) => pit.泵坑编号),
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '值班交接失败，请重试' }
  }
}
