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

/** 待办：与值班台账（duty）一一对应，台账怎么变待办就怎么变。 */
export type TodoItem = {
  id: number
  title: string
  shift: string
  date: string
  status: '待办' | '已办' | '遗留'
  sourceId: number
  createdAt: string
  doneAt: string
}

/** 变更轨迹：当前台账允许覆盖，历史只追加、不改原口径。 */
export type HistoryEvent = {
  id: number
  module: string
  refId: number
  refLabel: string
  action: string
  detail: string
  operator: string
  time: string
}

/** 本地持久化的整棵状态树：业务表、待办、历史一次落库，读到的永远是同一份。 */
export type StoreState = {
  version: number
  rows: Record<string, EntryRow[]>
  todos: TodoItem[]
  history: HistoryEvent[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
  drainage: { label: string; value: number }[]
}
