import {
  BACKFILL_BLANK,
  BACKFILL_MEDIAN,
  DRAINAGE_KEY,
  buildHistoryEvent,
  prepareLegacyPits,
  type LedgerBrief,
} from './drainage'
import { DRAINAGE_LEGACY_SEED, DUTY_SEED, SEED_ROWS } from './seed'
import type { DrainageHistoryEntry, DrainagePit, EntryRow } from './types'

/**
 * 本地持久化 v2：业务台账与排水操作历史放在同一份 state，一次 setItem 原子落库，
 * 刷新、关掉再打开、退出重进读到的都是同一份。
 * 旧版键 urban-utility-tunnel:entries（v1）首次读取时迁移一次。
 */
const LEGACY_STORAGE_KEY = 'urban-utility-tunnel:entries'
export const STORAGE_KEY = 'urban-utility-tunnel:state:v2'
const STATE_VERSION = 2

export type PersistedState = {
  version: number
  entries: Record<string, EntryRow[]>
  drainageHistory: DrainageHistoryEntry[]
}

export type StorageDriver = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultDriver(): StorageDriver | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  }
}

// 测试可注入驱动（内存 localStorage）；页面运行时走浏览器。
let driverOverride: StorageDriver | null = null
export function setStorageDriver(driver: StorageDriver | null): void {
  driverOverride = driver
  cache = null
}
function driver(): StorageDriver | null {
  return driverOverride ?? defaultDriver()
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isNumericField(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim()))
}

/** 旧版排水数据是否像示例占位串（廊内排水运维样例N），占位数据不进历史，直接按新种子播种。 */
function looksLikePlaceholder(rows: EntryRow[]): boolean {
  return rows.some((row) => !isNumericField(row['当前水位']) || !isNumericField(row['集水坑容积']))
}

function dutyLedgers(entries: Record<string, EntryRow[]>): LedgerBrief[] {
  return (entries['duty'] ?? [])
    .map((row) => ({
      交接编号: String(row['交接编号'] ?? ''),
      值班日期: String(row['值班日期'] ?? ''),
      班次: String(row['班次'] ?? ''),
    }))
    .filter((ledger) => ledger.交接编号)
}

/** 全新播种 / v1 升级走同一条存量处理路径，保证两套入口取值口径完全一致。 */
function buildInitialState(legacyRaw?: Record<string, EntryRow[]>): PersistedState {
  const entries: Record<string, EntryRow[]> = clone(SEED_ROWS)
  entries['duty'] = clone(DUTY_SEED)

  const history: DrainageHistoryEntry[] = []
  let seq = 0
  const actor = { operator: '系统迁移', shift: '存量班次迁移' }
  const stamp = '存量迁移'

  const legacyDrainage =
    legacyRaw && Array.isArray(legacyRaw[DRAINAGE_KEY]) && !looksLikePlaceholder(legacyRaw[DRAINAGE_KEY])
      ? (clone(legacyRaw[DRAINAGE_KEY]) as DrainagePit[])
      : clone(DRAINAGE_LEGACY_SEED)

  // 若升级自真实 v1 数据，其它模块沿用旧值，不丢改动。
  if (legacyRaw) {
    for (const [key, rows] of Object.entries(legacyRaw)) {
      if (key !== DRAINAGE_KEY && Array.isArray(rows)) entries[key] = clone(rows)
    }
  }

  const { pits, events } = prepareLegacyPits(legacyDrainage, dutyLedgers(entries))
  entries[DRAINAGE_KEY] = pits
  for (const event of events) {
    seq += 1
    history.push(buildHistoryEvent(seq, { 泵坑编号: event.pit.泵坑编号 }, '存量迁移', event.说明, actor, stamp))
  }

  return { version: STATE_VERSION, entries, drainageHistory: history }
}

function readPersisted(drv: StorageDriver): PersistedState {
  const raw = drv.getItem(STORAGE_KEY)
  if (raw) {
    const parsed = JSON.parse(raw) as PersistedState
    if (parsed && parsed.version === STATE_VERSION && parsed.entries) {
      return { ...parsed, drainageHistory: parsed.drainageHistory ?? [] }
    }
  }
  // v1 → v2：读旧键做存量迁移；旧键损坏也不阻塞，按新种子播种。
  let legacy: Record<string, EntryRow[]> | undefined
  const legacyRaw = drv.getItem(LEGACY_STORAGE_KEY)
  if (legacyRaw) {
    try {
      legacy = JSON.parse(legacyRaw) as Record<string, EntryRow[]>
    } catch {
      legacy = undefined
    }
  }
  const initial = buildInitialState(legacy)
  persist(drv, initial)
  if (legacyRaw) drv.removeItem(LEGACY_STORAGE_KEY)
  return initial
}

/**
 * 落库：超时/断线（QuotaExceeded、storage 不可写等）允许重试一次；
 * 仍失败把底层原因原样抛出，由页面写清楚，绝不静默回退到内存态。
 */
function persist(drv: StorageDriver, state: PersistedState): void {
  const payload = JSON.stringify(state)
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      drv.setItem(STORAGE_KEY, payload)
      if (drv.getItem(STORAGE_KEY) !== payload && attempt === 2) {
        throw new Error('写入后回读不一致')
      }
      return
    } catch (error) {
      lastError = error
      if (attempt === 1) continue
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`台账落库失败（已重试一次仍不成功）：${reason}。请检查浏览器存储空间或离线状态后再试。`)
}

let cache: PersistedState | null = null

export function getState(): PersistedState {
  if (cache !== null) return cache
  const drv = driver()
  if (!drv) {
    // 浏览器完全不可用时仍给出可操作的内存态，并明确这是不持久的。
    cache = buildInitialState()
    return cache
  }
  try {
    cache = readPersisted(drv)
  } catch {
    cache = buildInitialState()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return getState().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listDrainageHistory(): DrainageHistoryEntry[] {
  return getState().drainageHistory
}

export type CommitResult = { state: PersistedState }

/** 统一提交入口：改完一次性落库，保证台账与历史、列表与详情永远是同一份。 */
export function commit(mutate: (state: PersistedState) => void): CommitResult {
  const drv = driver()
  const snapshot = clone(getState())
  const next: PersistedState = clone(getState())
  mutate(next)
  if (drv) {
    try {
      persist(drv, next)
    } catch (error) {
      // 落库失败：内存回滚到提交前，刷新不会看到半成品。
      cache = snapshot
      throw error
    }
  }
  cache = next
  return { state: next }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit((state) => {
    state.entries[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  if (key === DRAINAGE_KEY) {
    const fresh = buildInitialState()
    commit((state) => {
      state.entries[DRAINAGE_KEY] = fresh.entries[DRAINAGE_KEY]
      state.drainageHistory = fresh.drainageHistory
    })
    return listRows(key)
  }
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 测试/调试：清空内存缓存，模拟刷新后重新从存储读取。 */
export function reloadCache(): PersistedState {
  cache = null
  return getState()
}

export function storageKey(): string {
  return STORAGE_KEY
}

export { BACKFILL_BLANK, BACKFILL_MEDIAN }
