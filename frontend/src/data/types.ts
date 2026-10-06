/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 操作人上下文：落库的每条修改、每段历史都带上是谁在哪个班次做的。 */
export type ActorContext = {
  operator: string
  shift: string
}

/**
 * 排水泵坑正式台账：泵坑编号、集水坑容积、当前水位、启泵水位一次落库、原地覆盖，
 * 列表、详情面板、导出、概览读到的都是这同一份。
 */
export type DrainagePit = EntryRow & {
  泵坑编号: string
  所属舱室: string
  集水坑容积: string
  当前水位: string
  /** 显式留空时为空串，页面统一显示「待核定」，并由待办催办补录。 */
  启泵水位: string
  排水泵编号: string
  值班人员: string
  排水状态: string
  /** 存量泵坑回填、按班次迁移的依据。 */
  上次巡检日期: string
  /** 迁移到的值班台账交接编号；待办与台账对账就按这个字段挂接。 */
  值班台账: string
  交接班次: string
  /** 启泵水位来源：同舱中位数补值 / 显式留空-待核定 / 存量原值保留 / 已补录；新登记为空串。 */
  补录标记: string
}

/** 排水台账的历史记录：只追加、不改写、不删除，历史永远按发生时的原口径保留。 */
export type DrainageHistoryEntry = {
  id: number
  时间: string
  泵坑编号: string
  操作: string
  说明: string
  操作员: string
  班次: string
}

/** 待办由对账结论派生（不单独存储），稳定 ID 保证同一泵坑同类待办只出现一次。 */
export type DrainageTodo = {
  id: string
  kind: '水位越线' | '启泵水位待补录' | '水泵故障'
  泵坑编号: string
  内容: string
  值班台账: string
  班次: string
}

/** 对账结论：待办条数与值班台账是否对得上，看这一份。 */
export type DrainageReconcileReport = {
  todos: DrainageTodo[]
  /** 每个值班台账挂了几条待办。 */
  todoCountByLedger: { 交接编号: string; 班次: string; 待办数: number }[]
  /** 本次自动校准的泵坑数。 */
  calibrated: number
  /** 全部待办是否都挂在真实存在的值班台账上。 */
  ledgerMatched: boolean
  message: string
}

/** 排水页面 / 概览的统一读模型。 */
export type DrainageView = {
  pits: DrainagePit[]
  stats: Record<string, number>
  todos: DrainageTodo[]
  report: DrainageReconcileReport
  history: DrainageHistoryEntry[]
}
