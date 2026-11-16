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

/** 建议状态流转的一条记录，序列化后保存在优化建议行的「状态路径」字段里。 */
export type StatusPathEntry = {
  status: string
  at: string
  by: string
  note: string
}

/** 查询改写数据集里的一条执行依据。一条建议最多对应一条，重复采纳不会新增。 */
export type QueryRewriteRecord = {
  rowId: number
  rewriteCode: string
  queryId: string
  queryName: string
  suggestionId: number
  suggestionCode: string
  originalQuery: string
  rewrittenQuery: string
  indexRef: string
  partitionRef: string
  status: string
  reviewer: string
  reviewedAt: string
  adoptedAt: string
  isCurrent: boolean
  pendingChecks: string[]
  statusPath: StatusPathEntry[]
  sourceRecord: string
  optimizationType: string
  estimatedLift: number
  generatedBy: string
  generatedAt: string
}

export type QueryCatalogEntry = {
  queryId: string
  queryName: string
  originalQuery: string
  datasource: string
  createdBy: string
  createdAt: string
  currentSuggestionCode: string
  currentRewriteCode: string
}

/** 新登记一条优化建议时提交的内容；分区/索引留空会被标为待核对。 */
export type SuggestionDraft = {
  queryId: string
  queryName?: string
  originalQuery?: string
  rewrittenQuery: string
  optimizationType: string
  estimatedLift: number
  indexRef: string
  partitionRef: string
  generatedBy?: string
  sourceRecord?: string
}

export type SuggestionView = {
  id: number
  code: string
  queryId: string
  queryName: string
  originalQuery: string
  rewrittenQuery: string
  optimizationType: string
  estimatedLift: number
  estimatedLiftText: string
  indexRef: string
  partitionRef: string
  status: string
  reviewer: string
  reviewedAt: string
  generatedBy: string
  generatedAt: string
  sourceRecord: string
  statusPath: StatusPathEntry[]
  pendingChecks: string[]
  isCurrent: boolean
  adoptedRewrite: QueryRewriteRecord | null
}

export type DiffSegment = {
  type: 'same' | 'add' | 'del'
  text: string
}

export type SuggestionDetail = {
  suggestion: SuggestionView
  diff: DiffSegment[]
  currentRewrite: QueryRewriteRecord | null
  isCurrent: boolean
  canAdopt: boolean
  canIgnore: boolean
  ignoreBlockedReason: string
  validationMessages: string[]
}

export type QueryGroupView = {
  queryId: string
  queryName: string
  originalQuery: string
  suggestionCount: number
  adoptedCount: number
  pendingCount: number
  ignoredCount: number
  currentSuggestionCode: string
  currentRewriteCode: string
  currentStatus: string
}

export type SuggestionGap = {
  suggestionCode: string
  field: string
  message: string
}

export type RewriteDatasetReport = {
  checkedSuggestions: number
  checkedRewrites: number
  repairedSuggestions: number
  repairedRewrites: number
  currentQueries: number
  gaps: SuggestionGap[]
  messages: string[]
}

export type QueryOptResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}

export type EvaluationLinkState = '当前版本' | '历史版本' | '待核对'

export type EvaluationView = {
  rowId: number
  code: string
  queryId: string
  suggestionCode: string
  rewriteCode: string
  recordedSuggestionCode: string
  recordedRewriteCode: string
  sourceRecord: string
  accuracy: string
  completeness: string
  speed: string
  abnormal: string
  note: string
  evaluatedAt: string
  status: string
  rewrite: QueryRewriteRecord | null
  linkState: EvaluationLinkState
  linkMessage: string
  diff: DiffSegment[]
}
