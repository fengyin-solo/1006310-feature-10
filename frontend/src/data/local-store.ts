import { SEED_ROWS } from './seed'
import type { EntryRow, HistoryEvent, StoreState, TodoItem } from './types'

// 本地持久化：整棵状态树（台账 + 待办 + 历史）放在 localStorage 里，刷新、关掉再打开都还是同一份。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
const STATE_VERSION = 2

// 早年台账只记了集水坑容积、没记启泵水位：统一按廊内泵坑常用启泵线 0.50m 补缺，
// 并在详情面板显式标「缺项补录」，提示值班员现场核实后覆盖。历史记录仍按原口径保留。
const LEGACY_START_LEVEL = 0.5

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

/** 数值字段：能解析就存数；解析不出来不猜，显式留空，等补录。 */
function numberOrBlank(value: unknown): number | string {
  if (isBlank(value)) {
    return ''
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : String(value)
}

function nextId(items: { id: number }[]): number {
  return items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function seedState(): StoreState {
  // 示例播种同样过一遍存量口径，保证新装与升级看到的补录结论一致。
  return migrateV1(clone(SEED_ROWS), [])
}

/**
 * 旧版（v1）存量数据迁移到现行口径，只补缺项、不改原值：
 * - 排水：存量泵坑按上次巡检日期回填；早年没记启泵水位的按 0.50m 统一补缺并标记补录；
 *   巡检日期无从考证的显式留空。每条泵坑留一条迁移历史。
 * - 值班：存量台账按「值班日期 + 班次」迁移到待办，缺项显式留空。
 */
function migrateV1(raw: Record<string, EntryRow[]>, events: HistoryEvent[]): StoreState {
  const rows: Record<string, EntryRow[]> = {}
  const todos: TodoItem[] = []
  const time = nowText()

  for (const [key, list] of Object.entries(raw)) {
    rows[key] = list.map((row) => ({ ...row }))
  }

  const drainage = rows['drainage'] ?? []
  for (const row of drainage) {
    if (!('上次巡检日期' in row)) {
      // 旧版没有该列，无据可考：显式留空，留给下一次巡检补录。
      row['上次巡检日期'] = ''
    }
    if (isBlank(row['启泵水位'])) {
      row['启泵水位'] = LEGACY_START_LEVEL
      row['启泵水位补录'] = true
      events.push({
        id: nextId(events),
        module: 'drainage',
        refId: row.id,
        refLabel: String(row['泵坑编号'] ?? `#${row.id}`),
        action: '存量迁移补录',
        detail: `早年台账缺启泵水位，按廊内常用启泵线 ${LEGACY_START_LEVEL}m 补缺，待现场核实；上次巡检日期无据可考，显式留空`,
        operator: '系统迁移',
        time,
      })
    }
    row['集水坑容积'] = numberOrBlank(row['集水坑容积'])
    row['当前水位'] = numberOrBlank(row['当前水位'])
    row['启泵水位'] = numberOrBlank(row['启泵水位'])
    row.pending = row.status !== '水位正常' && row.status !== '水泵故障'
  }

  const dutyFields = ['交接编号', '值班班组', '值班日期', '班次', '值班人员', '交接事项', '交接人员', '交接状态']
  for (const row of rows['duty'] ?? []) {
    for (const field of dutyFields) {
      if (!(field in row)) {
        row[field] = ''
      }
    }
    const status = String(row.status)
    todos.push({
      id: nextId(todos),
      title: `${row['值班日期'] || '日期待补'} ${row['班次'] || '班次待补'} 值班交接`,
      shift: String(row['班次'] ?? ''),
      date: String(row['值班日期'] ?? ''),
      status: status === '已交接' ? '已办' : status === '有遗留' ? '遗留' : '待办',
      sourceId: row.id,
      createdAt: time,
      doneAt: status === '已交接' ? time : '',
    })
    row.pending = status !== '已交接'
  }

  return { version: STATE_VERSION, rows, todos, history: events }
}

function readState(): StoreState {
  const fallback = seedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoreState
    // 现行版本：以存量为准，新增模块按现行播种口径补齐。
    if (parsed && parsed.version === STATE_VERSION && parsed.rows) {
      return {
        version: STATE_VERSION,
        rows: { ...seedState().rows, ...clone(parsed.rows) },
        todos: clone(parsed.todos ?? []),
        history: clone(parsed.history ?? []),
      }
    }
    // 旧版（v1 仅有 rows 的裸表结构）：迁移一次，迁移结论写进历史。
    const legacyRows = (parsed && parsed.rows ? parsed.rows : parsed) as Record<string, EntryRow[]>
    const migrated = migrateV1(legacyRows, [])
    commitState(migrated)
    return migrated
  } catch (error) {
    // 数据损坏：不静默吞，重置为示例数据并把原因带到控制台，页面操作仍可继续。
    console.warn('本地台账无法解析，已回退到示例数据：', error)
    commitState(fallback)
    return fallback
  }
}

/** 落库：超时/断线（localStorage 抛异常）允许重试一次，再失败把原因抛出给页面写清楚。 */
function commitState(state: StoreState): void {
  const payload = JSON.stringify(state)
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('当前环境不支持本地存储，刷新后改动无法保留')
  }
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      window.localStorage.setItem(STORAGE_KEY, payload)
      cache = state
      return
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `台账落库失败，已重试一次仍未成功：${
      lastError instanceof Error ? lastError.message : '浏览器存储不可用或空间不足'
    }`,
  )
}

let cache: StoreState | null = null

export function getState(): StoreState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return getState().rows
}

export function listRows(key: string): EntryRow[] {
  return getState().rows[key] ?? []
}

export function listTodos(): TodoItem[] {
  return getState().todos
}

export function listHistory(moduleKey?: string, refId?: number): HistoryEvent[] {
  const events = getState().history
  return events
    .filter((event) => (moduleKey ? event.module === moduleKey : true))
    .filter((event) => (refId === undefined ? true : event.refId === refId))
}

/** 追加一条变更历史并返回新的状态树（不落库，由 updateState 统一提交）。 */
export function withHistory(state: StoreState, event: Omit<HistoryEvent, 'id' | 'time'> & { time?: string }): StoreState {
  const history = [
    ...state.history,
    { id: nextId(state.history), time: nowText(), ...event },
  ]
  return { ...state, history }
}

/** 统一写入口：台账、待办、历史一次落库，要么都成功要么把原因交回页面。 */
export function updateState(produce: (state: StoreState) => StoreState): StoreState {
  const next = produce(clone(getState()))
  commitState(next)
  return next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  updateState((state) => ({ ...state, rows: { ...state.rows, [key]: rows } }))
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  updateState((state) => ({ ...state, rows: { ...state.rows, [key]: rows } }))
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
