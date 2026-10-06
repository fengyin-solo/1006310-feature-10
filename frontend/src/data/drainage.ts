import type {
  ActorContext,
  DrainageHistoryEntry,
  DrainagePit,
  DrainageReconcileReport,
  DrainageTodo,
  EntryRow,
} from './types'

/**
 * 廊内排水运维取值口径（全站只认这一份）：
 * - 状态：当前水位 > 启泵水位 → 排水中；当前水位 ≤ 启泵水位 → 水位正常；另有水泵故障。
 * - 待排水泵坑（概览口径）：状态为「待排水」或「排水中」且未故障的泵坑；
 *   「确认正常」一次就落到「水位正常」，待排水数只回落一次，重复确认不再回落。
 * - 存量启泵水位缺项：优先用「同舱室存量启泵水位中位数」补值并标注来源；
 *   同舱室没有可参照样本的，显式留空（页面显示「待核定」），生成补录待办挂值班台账。
 * - 存量泵坑按上次巡检日期迁移到「日期 ≤ 巡检日期」的最近一个值班台账（含交接中），
 *   找不到才退到最近的台账；历史记录只追加不改写。
 */

export const DRAINAGE_KEY = 'drainage'

export const DRAINAGE_STATUS = {
  pending: '待排水',
  draining: '排水中',
  normal: '水位正常',
  fault: '水泵故障',
} as const

export const DRAINAGE_ACTIONS = {
  start: '启动排水',
  confirmNormal: '确认正常',
  fault: '上报故障',
} as const

/** 启泵水位显式留空时，页面、导出统一显示这一份文案。 */
export const BLANK_LEVEL_LABEL = '待核定'

export const PIT_EDITABLE_FIELDS = ['泵坑编号', '集水坑容积', '当前水位', '启泵水位'] as const

export type EditableField = (typeof PIT_EDITABLE_FIELDS)[number]

export const BACKFILL_MEDIAN = '同舱中位数补值（存量迁移）'
export const BACKFILL_BLANK = `显式留空-待核定（存量迁移）`
export const BACKFILL_SUPPLEMENTED = '已补录（值班员补录）'
export const BACKFILL_NONE = ''

function numericText(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim()))
}

/** 解析米数；启泵水位留空时返回 null，调用方按「待核定」处理。 */
export function parseLevel(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const n = Number(value.trim())
  return Number.isFinite(n) ? n : null
}

export function formatLevel(value: number): string {
  return String(Number(value.toFixed(2)))
}

/** 同舱室存量启泵水位中位数，保留两位小数；没有可参照样本时返回 null（显式留空口径）。 */
export function chamberMedian(pits: DrainagePit[], chamber: string, selfId: number): string | null {
  const values = pits
    .filter((pit) => pit.id !== selfId && pit.所属舱室 === chamber)
    .map((pit) => parseLevel(pit.启泵水位))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b)
  if (values.length === 0) return null
  const mid = Math.floor(values.length / 2)
  const median = values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid]
  return formatLevel(median)
}

/** 纯水位口径：越线（>）进排水中，未越线（≤）即正常。 */
export function deriveStatus(current: unknown, threshold: unknown): string {
  const currentLevel = parseLevel(current)
  const startLevel = parseLevel(threshold)
  if (currentLevel === null || startLevel === null) return DRAINAGE_STATUS.pending
  return currentLevel > startLevel ? DRAINAGE_STATUS.draining : DRAINAGE_STATUS.normal
}

/** 概览「待排水泵坑数」口径：待排水 + 排水中，不含水泵故障。 */
export function isOpenPit(pit: DrainagePit): boolean {
  return pit.status === DRAINAGE_STATUS.pending || pit.status === DRAINAGE_STATUS.draining
}

export type LedgerBrief = { 交接编号: string; 值班日期: string; 班次: string }

/** 存量泵坑按上次巡检日期迁移：日期 ≤ 巡检日期的最近一个台账（交接中也算），找不到退最近台账。 */
export function matchLedger(ledgers: LedgerBrief[], inspectionDate: string): LedgerBrief | null {
  if (ledgers.length === 0) return null
  const eligible = ledgers
    .filter((ledger) => ledger.值班日期 <= inspectionDate)
    .sort((a, b) => b.值班日期.localeCompare(a.值班日期) || b.交接编号.localeCompare(a.交接编号))
  if (eligible.length > 0) return eligible[0]
  return [...ledgers].sort(
    (a, b) => b.值班日期.localeCompare(a.值班日期) || b.交接编号.localeCompare(a.交接编号),
  )[0]
}

export type BackfillResult = { pits: DrainagePit[]; events: { pit: DrainagePit; 说明: string }[] }

/**
 * 存量迁移（全新播种与 v1 升级走同一条路径，口径一致）：
 * 缺启泵水位的要么按同舱中位数补齐，要么显式留空并标记；班次按上次巡检日期挂台账。
 */
export function prepareLegacyPits(
  legacyPits: DrainagePit[],
  ledgers: LedgerBrief[],
): BackfillResult {
  const events: { pit: DrainagePit; 说明: string }[] = []
  const pits = legacyPits.map((raw) => {
    const pit: DrainagePit = { ...raw }
    if (!numericText(pit.集水坑容积)) pit.集水坑容积 = ''
    pit.当前水位 = numericText(pit.当前水位) ? String(Number(parseLevel(pit.当前水位))) : ''
    if (!numericText(pit.启泵水位)) {
      const median = chamberMedian(legacyPits, pit.所属舱室, pit.id)
      if (median !== null) {
        pit.启泵水位 = median
        pit.补录标记 = BACKFILL_MEDIAN
        events.push({ pit, 说明: `存量迁移：启泵水位按同舱中位数补值为 ${median} m` })
      } else {
        pit.启泵水位 = ''
        pit.补录标记 = BACKFILL_BLANK
        events.push({ pit, 说明: '存量迁移：早年未登记启泵水位且同舱无参照样本，显式留空待核定' })
      }
    } else {
      pit.启泵水位 = String(Number(parseLevel(pit.启泵水位)))
      if (!pit.补录标记) pit.补录标记 = BACKFILL_NONE
    }
    const ledger = matchLedger(ledgers, pit.上次巡检日期)
    pit.值班台账 = ledger?.交接编号 ?? ''
    pit.交接班次 = ledger ? `${ledger.值班日期} ${ledger.班次}` : ''
    if (!pit.值班台账) {
      events.push({ pit, 说明: '存量迁移：无对应值班台账，台账字段显式留空待补挂' })
    }
    pit.status = pit.status === DRAINAGE_STATUS.fault ? DRAINAGE_STATUS.fault : deriveStatus(pit.当前水位, pit.启泵水位)
    pit.pending = isOpenPit(pit)
    pit.abnormal = pit.status === DRAINAGE_STATUS.fault
    pit.排水状态 = pit.status
    return pit
  })
  return { pits, events }
}

/** 值班台账交接后的班次轮转：当日白班 → 当日夜班 → 次日白班。 */
export function nextShiftLabel(shift: string, date: string): { date: string; shift: string } {
  if (shift.includes('夜')) {
    const d = new Date(`${date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    return { date: d.toISOString().slice(0, 10), shift: '白班 08:00-20:00' }
  }
  return { date, shift: '夜班 20:00-次日08:00' }
}

export type CalibratedPit = { pit: DrainagePit; changed: boolean; note: string }
export type ReconcileResult = {
  calibrated: CalibratedPit[]
  todos: DrainageTodo[]
  ledgerMatched: boolean
  report: DrainageReconcileReport
}

/**
 * 对账（幂等）：水位口径自动校准 + 派生待办。
 * 同一泵坑重复确认正常只回落一次：状态已是「水位正常」时不会产生任何待办、也不重复计数。
 */
export function reconcileDrainage(
  pits: DrainagePit[],
  ledgers: LedgerBrief[],
  now: string,
  operator: string,
): ReconcileResult {
  const ledgerIds = new Set(ledgers.map((ledger) => ledger.交接编号))
  const calibrated: CalibratedPit[] = []
  const todos: DrainageTodo[] = []
  let ledgerMatched = true

  for (const raw of pits) {
    const pit: DrainagePit = { ...raw }
    const current = parseLevel(pit.当前水位)
    const threshold = parseLevel(pit.启泵水位)
    let note = ''

    if (pit.status === DRAINAGE_STATUS.fault) {
      // 故障单独挂账，不计入待排水数。
    } else if (threshold === null) {
      if (pit.status !== DRAINAGE_STATUS.pending) {
        pit.status = DRAINAGE_STATUS.pending
        note = '对账校准：启泵水位待核定，先回到待排水'
      }
    } else if (current !== null && current > threshold) {
      // 越线：把仍挂「待排水」的旧态自动收进排水中；
      // 值班员已确认「水位正常」的不推翻——水位再次越线时改一次当前水位保存即自动重进排水中。
      if (pit.status === DRAINAGE_STATUS.pending) {
        pit.status = DRAINAGE_STATUS.draining
        note = `对账校准：当前水位 ${formatLevel(current)} m 越过启泵线 ${formatLevel(threshold)} m，自动进入排水中`
      }
    } else if (current !== null && current <= threshold) {
      if (pit.status === DRAINAGE_STATUS.pending) {
        pit.status = DRAINAGE_STATUS.normal
        note = '对账校准：水位已低于启泵线且仍挂待排水，回落为水位正常'
      }
    }

    pit.pending = isOpenPit(pit)
    pit.abnormal = pit.status === DRAINAGE_STATUS.fault
    pit.排水状态 = pit.status

    if (pit.status === DRAINAGE_STATUS.fault) {
      todos.push({
        id: `${pit.id}:fault`,
        kind: '水泵故障',
        泵坑编号: pit.泵坑编号,
        内容: `${pit.泵坑编号}（${pit.所属舱室}）水泵故障，需检修后恢复`,
        值班台账: pit.值班台账,
        班次: pit.交接班次,
      })
    } else if (threshold === null) {
      todos.push({
        id: `${pit.id}:missing-threshold`,
        kind: '启泵水位待补录',
        泵坑编号: pit.泵坑编号,
        内容: `${pit.泵坑编号}（${pit.所属舱室}）启泵水位早年未登记，需现场补录核定`,
        值班台账: pit.值班台账,
        班次: pit.交接班次,
      })
    } else if (isOpenPit(pit) && current !== null && current > threshold) {
      todos.push({
        id: `${pit.id}:over-line`,
        kind: '水位越线',
        泵坑编号: pit.泵坑编号,
        内容: `${pit.泵坑编号}（${pit.所属舱室}）当前水位 ${formatLevel(current)} m 越过启泵线 ${formatLevel(threshold)} m，待排水`,
        值班台账: pit.值班台账,
        班次: pit.交接班次,
      })
    }
    if (pit.值班台账 && !ledgerIds.has(pit.值班台账)) ledgerMatched = false
    if (note) calibrated.push({ pit, changed: true, note })
    const index = pits.findIndex((item) => item.id === pit.id)
    if (index >= 0) pits[index] = pit
  }

  const counts = new Map<string, number>()
  for (const todo of todos) {
    counts.set(todo.值班台账, (counts.get(todo.值班台账) ?? 0) + 1)
  }
  const todoCountByLedger = ledgers.map((ledger) => ({
    交接编号: ledger.交接编号,
    班次: `${ledger.值班日期} ${ledger.班次}`,
    待办数: counts.get(ledger.交接编号) ?? 0,
  }))
  const openCount = pits.filter(isOpenPit).length
  const message =
    todos.length === 0
      ? `对账完成：无待办，待排水泵坑 ${openCount} 个，台账账实相符`
      : `对账完成：待办 ${todos.length} 条，已按班次挂到 ${todoCountByLedger.filter((item) => item.待办数 > 0).length} 本值班台账，待排水泵坑 ${openCount} 个`

  return {
    calibrated,
    todos,
    ledgerMatched,
    report: { todos, todoCountByLedger, calibrated: calibrated.length, ledgerMatched, message },
  }
}

/** 台账交接迁移：未闭环泵坑与待办随班迁到下一本台账，已闭环的留在原班次。 */
export function migrateOpenPitsToLedger(
  pits: DrainagePit[],
  fromLedger: string,
  nextLedger: { 交接编号: string; 班次: string },
): DrainagePit[] {
  return pits.map((pit) =>
    pit.值班台账 === fromLedger && isOpenPit(pit)
      ? { ...pit, 值班台账: nextLedger.交接编号, 交接班次: nextLedger.班次 }
      : pit,
  )
}

export function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function buildHistoryEvent(
  seq: number,
  pit: Pick<DrainagePit, '泵坑编号'>,
  action: string,
  note: string,
  actor: ActorContext,
  stamp = nowStamp(),
): DrainageHistoryEntry {
  return {
    id: seq,
    时间: stamp,
    泵坑编号: pit.泵坑编号,
    操作: action,
    说明: note,
    操作员: actor.operator,
    班次: actor.shift,
  }
}

/** 排水统计指标（概览与页面共用一份口径）。 */
export function drainageStats(pits: DrainagePit[]): Record<string, number> {
  return {
    待排水泵坑: pits.filter(isOpenPit).length,
    排水中泵坑: pits.filter((pit) => pit.status === DRAINAGE_STATUS.draining).length,
    水泵故障数: pits.filter((pit) => pit.status === DRAINAGE_STATUS.fault).length,
    水位正常泵坑: pits.filter((pit) => pit.status === DRAINAGE_STATUS.normal).length,
    待核定启泵水位: pits.filter((pit) => parseLevel(pit.启泵水位) === null).length,
  }
}

/** 通用模块行里取排水坑（结构兼容，localStorage 里 drainage 段就是 DrainagePit[]）。 */
export function asPits(rows: EntryRow[]): DrainagePit[] {
  return rows as DrainagePit[]
}
