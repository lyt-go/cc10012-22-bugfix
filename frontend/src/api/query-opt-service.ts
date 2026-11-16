import { listRows, saveRows } from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import {
  cloneRows,
  ensureQueryOptSchema,
  loadCatalog,
  loadRewrites,
  resetQueryOptModule,
  resetResultEvalModule,
  saveCatalog,
  saveRewrites,
} from '@/data/query-opt-store'
import type {
  DiffSegment,
  EntryRow,
  EvaluationLinkState,
  EvaluationView,
  QueryCatalogEntry,
  QueryGroupView,
  QueryOptResult,
  QueryRewriteRecord,
  RewriteDatasetReport,
  StatusPathEntry,
  SuggestionDetail,
  SuggestionDraft,
  SuggestionGap,
  SuggestionView,
} from '@/data/types'

const QUERY_OPT = 'queryopt'
const RESULT_EVAL = 'resulteval'
const ACTIVE_STATUSES = ['草稿', '优化建议中']
const ADOPTED_STATUS = '已采纳'
const IGNORED_STATUS = '已忽略'

/** 待核对字段：缺失时保留占位，绝不从别的建议借字段补全。 */
const CHECK_FIELDS = ['涉及索引', '涉及分区'] as const

function nowStamp(at?: string): string {
  if (at) {
    return at
  }
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function parseStatusPath(raw: unknown): StatusPathEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        status: text(item.status),
        at: text(item.at),
        by: text(item.by),
        note: text(item.note),
      }))
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    return parseStatusPath(JSON.parse(raw))
  } catch {
    return []
  }
}

function parseList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => text(item)).filter((item) => item !== '')
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    return parseList(JSON.parse(raw))
  } catch {
    return []
  }
}

function pendingChecksFor(row: EntryRow): string[] {
  return CHECK_FIELDS.filter((field) => text(row[field]).trim() === '')
}

function liftOf(row: EntryRow): number {
  const value = Number(row['预估提升'])
  return Number.isFinite(value) ? value : 0
}

function nextCode(prefix: string, existing: string[]): string {
  let max = 0
  for (const code of existing) {
    const matched = /(\d+)$/.exec(code)
    if (matched) {
      max = Math.max(max, Number(matched[1]))
    }
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function rewriteCodeFor(rewrites: QueryRewriteRecord[]): string {
  return nextCode('RW', rewrites.map((item) => item.rewriteCode))
}

function suggestionCodeFor(rows: EntryRow[]): string {
  return nextCode('OPT', rows.map((row) => text(row['建议编号'])))
}

/* ------------------------------------------------------------------ */
/* 差异比较：评估入口要展示原查询与改写查询的具体差异                  */
/* ------------------------------------------------------------------ */

function tokenize(sql: string): string[] {
  return sql.match(/[\s]+|[A-Za-z0-9_*.:]+|[^\sA-Za-z0-9_*.:]/g) ?? []
}

/** 基于 LCS 的逐词差异，返回可直接渲染的增/删/同段落。 */
export function diffQuery(original: string, rewritten: string): DiffSegment[] {
  const left = tokenize(original)
  const right = tokenize(rewritten)
  if (left.join('') === right.join('')) {
    return left.length ? [{ type: 'same', text: original }] : []
  }
  const rows = left.length + 1
  const cols = right.length + 1
  // 大 SQL 控制规模，避免 DP 表无限膨胀；超出后退化为整段对比。
  if (rows * cols > 250_000) {
    return [
      { type: 'del', text: original },
      { type: 'add', text: rewritten },
    ]
  }
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const segments: DiffSegment[] = []
  const push = (type: DiffSegment['type'], value: string) => {
    if (value === '') {
      return
    }
    const last = segments[segments.length - 1]
    if (last && last.type === type) {
      last.text += value
    } else {
      segments.push({ type, text: value })
    }
  }
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push('same', left[i])
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push('del', left[i])
      i += 1
    } else {
      push('add', right[j])
      j += 1
    }
  }
  while (i < left.length) {
    push('del', left[i])
    i += 1
  }
  while (j < right.length) {
    push('add', right[j])
    j += 1
  }
  return segments
}

/* ------------------------------------------------------------------ */
/* 状态路径：生成 / 评审 / 采纳 / 忽略都留痕                            */
/* ------------------------------------------------------------------ */

function appendPath(row: EntryRow, entry: StatusPathEntry): StatusPathEntry[] {
  const path = parseStatusPath(row['状态路径'])
  path.push(entry)
  return path
}

function writeRowPath(row: EntryRow, path: StatusPathEntry[]): EntryRow {
  return { ...row, 状态路径: JSON.stringify(path) }
}

/* ------------------------------------------------------------------ */
/* 读取视图                                                            */
/* ------------------------------------------------------------------ */

function currentRewriteFrom(rewrites: QueryRewriteRecord[], queryId: string): QueryRewriteRecord | null {
  const current = rewrites.filter((item) => item.queryId === queryId && item.isCurrent)
  if (current.length === 0) {
    return null
  }
  // 唯一当前版本：评审时间最近者优先；同一时刻再看预估提升，最后用行号兜底。
  return [...current].sort((a, b) => {
    if (a.reviewedAt !== b.reviewedAt) {
      return a.reviewedAt < b.reviewedAt ? 1 : -1
    }
    if (a.estimatedLift !== b.estimatedLift) {
      return b.estimatedLift - a.estimatedLift
    }
    return b.rowId - a.rowId
  })[0]
}

function adoptedRewriteForSuggestion(rewrites: QueryRewriteRecord[], suggestionId: number): QueryRewriteRecord | null {
  return rewrites.find((item) => item.suggestionId === suggestionId) ?? null
}

function toSuggestionView(
  row: EntryRow,
  catalog: QueryCatalogEntry[],
  rewrites: QueryRewriteRecord[],
): SuggestionView {
  const queryId = text(row['查询标识'])
  const catalogEntry = catalog.find((item) => item.queryId === queryId)
  const current = currentRewriteFrom(rewrites, queryId)
  const own = adoptedRewriteForSuggestion(rewrites, Number(row.id))
  const checks = parseList(row['待核对'])
  return {
    id: Number(row.id),
    code: text(row['建议编号']),
    queryId,
    queryName: catalogEntry?.queryName ?? text(row['查询名称']),
    originalQuery: text(row['原始查询']) || catalogEntry?.originalQuery || '',
    rewrittenQuery: text(row['优化后查询']),
    optimizationType: text(row['优化类型']),
    estimatedLift: liftOf(row),
    estimatedLiftText: `${liftOf(row)}%`,
    indexRef: text(row['涉及索引']),
    partitionRef: text(row['涉及分区']),
    status: text(row.status),
    reviewer: text(row['评审人']),
    reviewedAt: text(row['评审时间']),
    generatedBy: text(row['生成人']),
    generatedAt: text(row['生成时间']),
    sourceRecord: text(row['来源记录']),
    statusPath: parseStatusPath(row['状态路径']),
    pendingChecks: checks,
    isCurrent: Boolean(current && own && current.rewriteCode === own.rewriteCode),
    adoptedRewrite: own,
  }
}

export function listSuggestions(queryId = ''): SuggestionView[] {
  ensureQueryOptSchema()
  const catalog = loadCatalog()
  const rewrites = loadRewrites()
  const rows = listRows(QUERY_OPT)
  return rows
    .filter((row) => (queryId === '' ? true : text(row['查询标识']) === queryId))
    .map((row) => toSuggestionView(row, catalog, rewrites))
}

export function listQueryGroups(): QueryGroupView[] {
  ensureQueryOptSchema()
  const catalog = loadCatalog()
  const rewrites = loadRewrites()
  const rows = listRows(QUERY_OPT)
  return catalog.map((entry) => {
    const own = rows.filter((row) => text(row['查询标识']) === entry.queryId)
    const current = currentRewriteFrom(rewrites, entry.queryId)
    const currentRow = current ? own.find((row) => Number(row.id) === current.rowId) : undefined
    return {
      queryId: entry.queryId,
      queryName: entry.queryName,
      originalQuery: entry.originalQuery,
      suggestionCount: own.length,
      adoptedCount: own.filter((row) => text(row.status) === ADOPTED_STATUS).length,
      pendingCount: own.filter((row) => ACTIVE_STATUSES.includes(text(row.status))).length,
      ignoredCount: own.filter((row) => text(row.status) === IGNORED_STATUS).length,
      currentSuggestionCode: current?.suggestionCode ?? '',
      currentRewriteCode: current?.rewriteCode ?? '',
      currentStatus: currentRow ? text(currentRow.status) : current ? ADOPTED_STATUS : '未采纳',
    }
  })
}

export function getSuggestionDetail(suggestionId: number): QueryOptResult<SuggestionDetail> {
  ensureQueryOptSchema()
  const catalog = loadCatalog()
  const rewrites = loadRewrites()
  const rows = listRows(QUERY_OPT)
  const row = rows.find((item) => Number(item.id) === suggestionId)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${suggestionId} 的优化建议` }
  }
  const suggestion = toSuggestionView(row, catalog, rewrites)
  const current = currentRewriteFrom(rewrites, suggestion.queryId)
  const isCurrent = Boolean(current && current.suggestionId === suggestionId)
  const canAdopt = ACTIVE_STATUSES.includes(suggestion.status) || suggestion.status === ADOPTED_STATUS
  const canIgnore = ACTIVE_STATUSES.includes(suggestion.status)
  return {
    ok: true,
    message: '已读取优化建议详情',
    data: {
      suggestion,
      diff: diffQuery(suggestion.originalQuery, suggestion.rewrittenQuery),
      currentRewrite: current,
      isCurrent,
      canAdopt,
      canIgnore,
      ignoreBlockedReason:
        suggestion.status === ADOPTED_STATUS
          ? '该建议是当前执行版本，需先采纳其他建议再忽略，避免评估入口失去唯一依据'
          : suggestion.status === IGNORED_STATUS
            ? '该建议已是已忽略状态'
            : '',
      validationMessages: validateSuggestion(suggestion, rewrites, catalog),
    },
  }
}

/* ------------------------------------------------------------------ */
/* 校验：缺口只登记，不用别的建议补                                  */
/* ------------------------------------------------------------------ */

function validateSuggestion(
  suggestion: SuggestionView,
  rewrites: QueryRewriteRecord[],
  catalog: QueryCatalogEntry[],
): string[] {
  const messages: string[] = []
  const entry = catalog.find((item) => item.queryId === suggestion.queryId)
  if (!entry) {
    messages.push(`查询标识 ${suggestion.queryId || '（空）'} 未登记在查询目录中`)
  } else if (suggestion.originalQuery !== entry.originalQuery) {
    messages.push('原始查询与查询目录不一致，需保留目录中的原查询后再评估')
  }
  if (suggestion.rewrittenQuery.trim() === '') {
    messages.push('优化后查询为空，不能作为执行依据')
  }
  if (suggestion.rewrittenQuery.trim() !== '' && suggestion.rewrittenQuery === suggestion.originalQuery) {
    messages.push('优化后查询与原始查询相同，没有可评估的改写差异')
  }
  for (const field of CHECK_FIELDS) {
    const value = field === '涉及索引' ? suggestion.indexRef : suggestion.partitionRef
    if (value.trim() === '') {
      messages.push(`${field}缺失，保留为待核对，不从其他建议补全`)
    }
  }
  if (!['草稿', '优化建议中', ADOPTED_STATUS, IGNORED_STATUS].includes(suggestion.status)) {
    messages.push(`建议状态「${suggestion.status}」不在登记范围内`)
  }
  if (suggestion.status === ADOPTED_STATUS) {
    if (suggestion.reviewer.trim() === '' || suggestion.reviewedAt.trim() === '') {
      messages.push('已采纳建议缺少评审人或评审时间')
    }
    if (suggestion.adoptedRewrite === null) {
      messages.push('已采纳建议在查询改写数据集中没有执行依据，需要补写')
    }
  }
  if (suggestion.adoptedRewrite) {
    const record = suggestion.adoptedRewrite
    if (record.originalQuery !== suggestion.originalQuery) {
      messages.push('改写数据集中的原始查询与建议不一致')
    }
    if (record.rewrittenQuery !== suggestion.rewrittenQuery) {
      messages.push('改写数据集中的优化后查询与建议不一致')
    }
    if (record.indexRef !== suggestion.indexRef) {
      messages.push('改写数据集中的涉及索引与建议不一致')
    }
    if (record.partitionRef !== suggestion.partitionRef) {
      messages.push('改写数据集中的涉及分区与建议不一致')
    }
    if (record.status !== suggestion.status) {
      messages.push('改写数据集中的状态与建议不一致')
    }
  }
  const duplicated = rewrites.filter((item) => item.suggestionId === suggestion.id)
  if (duplicated.length > 1) {
    messages.push('同一建议存在多份执行依据，需合并为一份')
  }
  return messages
}

export function validateSuggestions(): SuggestionGap[] {
  ensureQueryOptSchema()
  const catalog = loadCatalog()
  const rewrites = loadRewrites()
  const rows = listRows(QUERY_OPT)
  const gaps: SuggestionGap[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const suggestion = toSuggestionView(row, catalog, rewrites)
    const messages = validateSuggestion(suggestion, rewrites, catalog)
    for (const check of suggestion.pendingChecks) {
      const message = `${check}缺失，保留为待核对`
      if (!messages.includes(message) && !messages.some((item) => item.startsWith(`${check}缺失`))) {
        messages.push(message)
      }
    }
    for (const message of messages) {
      const key = `${suggestion.code}|${message}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      gaps.push({ suggestionCode: suggestion.code, field: gapField(message), message })
    }
  }
  const currentCount = new Map<string, number>()
  for (const record of rewrites.filter((item) => item.isCurrent)) {
    currentCount.set(record.queryId, (currentCount.get(record.queryId) ?? 0) + 1)
  }
  for (const [queryId, count] of currentCount) {
    if (count > 1) {
      gaps.push({
        suggestionCode: queryId,
        field: '当前版本',
        message: `查询 ${queryId} 有 ${count} 份当前执行依据，评估入口只能读取唯一版本`,
      })
    }
  }
  return gaps
}

function gapField(message: string): string {
  if (message.includes('涉及分区')) {
    return '涉及分区'
  }
  if (message.includes('涉及索引')) {
    return '涉及索引'
  }
  if (message.includes('原始查询')) {
    return '原始查询'
  }
  if (message.includes('优化后查询')) {
    return '优化后查询'
  }
  if (message.includes('评审')) {
    return '评审信息'
  }
  return '建议状态'
}

/* ------------------------------------------------------------------ */
/* 查询改写数据集：生成 / 补写 / 幂等                                  */
/* ------------------------------------------------------------------ */

function buildRewriteFromRow(
  row: EntryRow,
  catalogEntry: QueryCatalogEntry | undefined,
  code: string,
  isCurrent: boolean,
): QueryRewriteRecord {
  const path = parseStatusPath(row['状态路径'])
  return {
    rowId: Number(row.id),
    rewriteCode: code,
    queryId: text(row['查询标识']),
    queryName: catalogEntry?.queryName ?? text(row['查询名称']),
    suggestionId: Number(row.id),
    suggestionCode: text(row['建议编号']),
    originalQuery: text(row['原始查询']) || catalogEntry?.originalQuery || '',
    rewrittenQuery: text(row['优化后查询']),
    indexRef: text(row['涉及索引']),
    partitionRef: text(row['涉及分区']),
    status: text(row.status),
    reviewer: text(row['评审人']),
    reviewedAt: text(row['评审时间']),
    adoptedAt: text(row['评审时间']),
    isCurrent,
    pendingChecks: pendingChecksFor(row),
    statusPath: path.length
      ? path
      : [{ status: text(row.status), at: text(row['评审时间']), by: text(row['评审人']), note: '历史状态补录' }],
    sourceRecord: `优化建议 ${text(row['建议编号'])} ← ${text(row['来源记录']) || '未登记来源'}`,
    optimizationType: text(row['优化类型']),
    estimatedLift: liftOf(row),
    generatedBy: text(row['生成人']),
    generatedAt: text(row['生成时间']),
  }
}

/**
 * 唯一当前版本：
 * - 每个查询恰好有一份 isCurrent 时原样保留，重复采纳不会把评估依据切走；
 * - 没有或有多份时才归一，按评审时间最近、再按预估提升高者裁决。
 * 这让「设计者选定的版本」不被时间戳机械覆盖，同时保证最终只有一份。
 */
function normalizeCurrent(records: QueryRewriteRecord[]): QueryRewriteRecord[] {
  const byQuery = new Map<string, QueryRewriteRecord[]>()
  for (const record of records) {
    const list = byQuery.get(record.queryId) ?? []
    list.push(record)
    byQuery.set(record.queryId, list)
  }
  const chosen = new Map<string, QueryRewriteRecord>()
  const rank = (a: QueryRewriteRecord, b: QueryRewriteRecord) => {
    if (a.reviewedAt !== b.reviewedAt) {
      return a.reviewedAt < b.reviewedAt ? 1 : -1
    }
    if (a.estimatedLift !== b.estimatedLift) {
      return b.estimatedLift - a.estimatedLift
    }
    return b.rowId - a.rowId
  }
  for (const [queryId, list] of byQuery) {
    const current = list.filter((item) => item.isCurrent)
    if (current.length === 1) {
      chosen.set(queryId, current[0])
    } else if (current.length > 1) {
      chosen.set(queryId, [...current].sort(rank)[0])
    } else {
      chosen.set(queryId, [...list].sort(rank)[0])
    }
  }
  return records.map((record) => ({
    ...record,
    isCurrent: chosen.get(record.queryId)?.rewriteCode === record.rewriteCode,
  }))
}

/**
 * 生成/补写查询改写数据集：
 * - 已采纳建议必须有执行依据，缺失时只用该建议自己的字段补写；
 * - 已存在的执行依据保持原有内容，重复执行不会新增第二份；
 * - 涉及索引/分区缺失时保留待核对，不从别的建议拿字段补。
 */
export function generateRewriteDataset(at?: string): RewriteDatasetReport {
  ensureQueryOptSchema()
  const stamp = nowStamp(at)
  const catalog = loadCatalog()
  const rawRows = cloneRows(listRows(QUERY_OPT))
  const rewrites = loadRewrites()
  const messages: string[] = []
  let repairedSuggestions = 0
  let repairedRewrites = 0

  const rows = rawRows.map((row) => {
    let next = { ...row }
    const checks = pendingChecksFor(next)
    if (next['待核对'] === undefined) {
      next['待核对'] = JSON.stringify(checks)
      repairedSuggestions += 1
    }
    if (next['建议状态'] === undefined) {
      next['建议状态'] = text(next.status)
      repairedSuggestions += 1
    }
    if (parseStatusPath(next['状态路径']).length === 0 && !ACTIVE_STATUSES.includes(text(next.status))) {
      next['状态路径'] = JSON.stringify([
        {
          status: text(next.status),
          at: text(next['评审时间']) || stamp,
          by: text(next['评审人']) || '系统补录',
          note: '历史状态补录',
        },
      ])
      repairedSuggestions += 1
    }
    if (ACTIVE_STATUSES.includes(text(next.status)) && checks.length > 0) {
      const listed = parseList(next['待核对'])
      if (listed.join('|') !== checks.join('|')) {
        next['待核对'] = JSON.stringify(checks)
        repairedSuggestions += 1
      }
    }
    return next
  })

  const catalogFor = (queryId: string) => catalog.find((item) => item.queryId === queryId)
  const adoptedRows = rows.filter((row) => text(row.status) === ADOPTED_STATUS)
  const existingBySuggestion = new Map<number, QueryRewriteRecord>()
  for (const record of rewrites) {
    if (!existingBySuggestion.has(record.suggestionId)) {
      existingBySuggestion.set(record.suggestionId, record)
    }
  }

  let nextRewrites: QueryRewriteRecord[] = [...rewrites]
  let codeSeq = rewrites.reduce((max, item) => {
    const matched = /(\d+)$/.exec(item.rewriteCode)
    return matched ? Math.max(max, Number(matched[1])) : max
  }, 0)

  for (const row of adoptedRows) {
    const suggestionId = Number(row.id)
    const existing = existingBySuggestion.get(suggestionId)
    if (existing) {
      const patched: QueryRewriteRecord = {
        ...existing,
        // 只用该建议自己的字段补齐，空值保持空值并登记待核对。
        originalQuery: existing.originalQuery || text(row['原始查询']) || catalogFor(text(row['查询标识']))?.originalQuery || '',
        rewrittenQuery: existing.rewrittenQuery || text(row['优化后查询']),
        indexRef: existing.indexRef || text(row['涉及索引']),
        partitionRef: existing.partitionRef || text(row['涉及分区']),
        reviewer: existing.reviewer || text(row['评审人']),
        reviewedAt: existing.reviewedAt || text(row['评审时间']),
        adoptedAt: existing.adoptedAt || text(row['评审时间']),
        status: text(row.status),
        pendingChecks: pendingChecksFor(row),
        sourceRecord: existing.sourceRecord || `优化建议 ${text(row['建议编号'])} ← ${text(row['来源记录']) || '未登记来源'}`,
      }
      if (JSON.stringify(patched) !== JSON.stringify(existing)) {
        nextRewrites = nextRewrites.map((item) => (item.suggestionId === suggestionId ? patched : item))
        repairedRewrites += 1
      }
      if (!text(row['改写编号'])) {
        row['改写编号'] = patched.rewriteCode
        repairedSuggestions += 1
      }
      continue
    }
    codeSeq += 1
    const code = `RW-${String(codeSeq).padStart(4, '0')}`
    const record = buildRewriteFromRow(row, catalogFor(text(row['查询标识'])), code, false)
    nextRewrites.push(record)
    existingBySuggestion.set(suggestionId, record)
    row['改写编号'] = code
    repairedRewrites += 1
    repairedSuggestions += 1
    messages.push(`为已采纳建议 ${text(row['建议编号'])} 补写执行依据 ${code}`)
  }

  nextRewrites = normalizeCurrent(nextRewrites)

  // 已采纳的建议行同步当前版本标记，便于列表和详情读到同一份状态。
  const savedRows = rows.map((row) => {
    const record = nextRewrites.find((item) => item.suggestionId === Number(row.id))
    if (!record) {
      return row
    }
    const current = record.isCurrent
    const nextStatus = text(row.status) === ADOPTED_STATUS ? ADOPTED_STATUS : text(row.status)
    if (text(row['改写编号']) === record.rewriteCode && text(row['建议状态']) === nextStatus && text(row.status) === nextStatus) {
      return row
    }
    return {
      ...row,
      建议状态: nextStatus,
      改写编号: record.rewriteCode,
    }
  })

  saveRows(QUERY_OPT, savedRows)
  saveRewrites(nextRewrites)

  const updatedCatalog = catalog.map((entry) => {
    const current = nextRewrites.find((item) => item.queryId === entry.queryId && item.isCurrent)
    return {
      ...entry,
      currentSuggestionCode: current?.suggestionCode ?? '',
      currentRewriteCode: current?.rewriteCode ?? '',
    }
  })
  saveCatalog(updatedCatalog)

  const evalMessages = syncEvaluationLinks(nextRewrites, updatedCatalog, stamp)
  messages.push(...evalMessages)

  const gaps = validateSuggestions()
  return {
    checkedSuggestions: savedRows.length,
    checkedRewrites: nextRewrites.length,
    repairedSuggestions,
    repairedRewrites,
    currentQueries: updatedCatalog.filter((entry) => entry.currentRewriteCode !== '').length,
    gaps,
    messages,
  }
}

/* ------------------------------------------------------------------ */
/* 写操作：生成 / 采纳 / 忽略                                          */
/* ------------------------------------------------------------------ */

const inFlight = new Set<string>()

function withLock<T>(key: string, task: () => T): T | null {
  if (inFlight.has(key)) {
    return null
  }
  inFlight.add(key)
  try {
    return task()
  } finally {
    inFlight.delete(key)
  }
}

export function upsertCatalogEntry(input: {
  queryId: string
  queryName: string
  originalQuery: string
  datasource?: string
  createdBy?: string
}): QueryCatalogEntry {
  const catalog = loadCatalog()
  const existing = catalog.find((item) => item.queryId === input.queryId)
  if (existing) {
    return existing
  }
  const entry: QueryCatalogEntry = {
    queryId: input.queryId,
    queryName: input.queryName,
    originalQuery: input.originalQuery,
    datasource: input.datasource ?? '分析库 dm_analytics',
    createdBy: input.createdBy ?? '值班管理员',
    createdAt: nowStamp(),
    currentSuggestionCode: '',
    currentRewriteCode: '',
  }
  saveCatalog([...catalog, entry])
  return entry
}

export function createSuggestion(draft: SuggestionDraft): QueryOptResult<SuggestionView> {
  const catalog = loadCatalog()
  let entry = catalog.find((item) => item.queryId === draft.queryId)
  if (!entry) {
    if (!draft.queryName || !draft.originalQuery) {
      return { ok: false, message: `查询标识 ${draft.queryId} 未登记，需同时提供查询名称和原始查询` }
    }
    entry = upsertCatalogEntry({
      queryId: draft.queryId,
      queryName: draft.queryName,
      originalQuery: draft.originalQuery,
      createdBy: draft.generatedBy,
    })
  }
  if (draft.rewrittenQuery.trim() === '') {
    return { ok: false, message: '优化后查询不能为空' }
  }
  const rows = listRows(QUERY_OPT)
  const code = suggestionCodeFor(rows)
  const generatedBy = draft.generatedBy?.trim() || '优化引擎'
  const stamp = nowStamp()
  const row: EntryRow = {
    id: rows.reduce((max, item) => Math.max(max, Number(item.id)), 0) + 1,
    status: '优化建议中',
    pending: true,
    abnormal: false,
    查询标识: entry.queryId,
    建议编号: code,
    原始查询: entry.originalQuery,
    优化后查询: draft.rewrittenQuery,
    优化类型: draft.optimizationType,
    预估提升: Number.isFinite(draft.estimatedLift) ? draft.estimatedLift : 0,
    涉及索引: draft.indexRef,
    涉及分区: draft.partitionRef,
    建议状态: '优化建议中',
    评审人: '',
    评审时间: '',
    生成人: generatedBy,
    生成时间: stamp,
    来源记录: draft.sourceRecord?.trim() || '手工登记',
    改写编号: '',
    待核对: JSON.stringify(CHECK_FIELDS.filter((field) => text(draft[field === '涉及索引' ? 'indexRef' : 'partitionRef']).trim() === '')),
    状态路径: JSON.stringify([
      { status: '优化建议中', at: stamp, by: generatedBy, note: '生成建议' },
    ]),
  }
  saveRows(QUERY_OPT, [...rows, row])
  // 新草稿只写建议表，不碰已采纳建议、当前改写版本和目录指针。
  const catalogAfter = loadCatalog()
  const suggestion = toSuggestionView(row, catalogAfter, loadRewrites())
  return { ok: true, message: `已生成优化建议 ${code}，待评审`, data: suggestion }
}

export function adoptSuggestion(
  suggestionId: number,
  actor: { reviewer?: string; at?: string } = {},
): QueryOptResult<SuggestionDetail> {
  const locked = withLock(`queryopt:${suggestionId}`, () => {
    ensureQueryOptSchema()
    const reviewer = actor.reviewer?.trim() || '值班管理员'
    const stamp = nowStamp(actor.at)
    const rows = cloneRows(listRows(QUERY_OPT))
    const index = rows.findIndex((row) => Number(row.id) === suggestionId)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${suggestionId} 的优化建议` }
    }
    const row = rows[index]
    const code = text(row['建议编号'])
    const catalog = loadCatalog()
    const rewrites = loadRewrites()

    if (text(row.status) === ADOPTED_STATUS) {
      // 重复采纳：只更新评审时间，不新增第二份执行依据，终态保持已采纳。
      const updated: EntryRow = {
        ...row,
        评审人: reviewer,
        评审时间: stamp,
        建议状态: ADOPTED_STATUS,
        状态路径: JSON.stringify(
          appendPath(row, { status: ADOPTED_STATUS, at: stamp, by: reviewer, note: '重复采纳，仅更新评审时间' }),
        ),
      }
      rows[index] = updated
      const own = adoptedRewriteForSuggestion(rewrites, suggestionId)
      let nextRewrites: QueryRewriteRecord[]
      if (own) {
        nextRewrites = rewrites.map((item) =>
          item.suggestionId === suggestionId ? { ...item, reviewer, reviewedAt: stamp, adoptedAt: stamp } : item,
        )
      } else {
        // 历史数据缺执行依据：补写一份，仍只保留这一份，并同步建议行的改写编号。
        const code = text(row['改写编号']) || rewriteCodeFor(rewrites)
        const catalogEntry = loadCatalog().find((item) => item.queryId === text(row['查询标识']))
        const record = buildRewriteFromRow(updated, catalogEntry, code, false)
        nextRewrites = normalizeCurrent([...rewrites, record])
        rows[index] = { ...updated, 改写编号: code }
      }
      nextRewrites = normalizeCurrent(nextRewrites)
      saveRows(QUERY_OPT, rows)
      saveRewrites(nextRewrites)
      return {
        ok: true,
        message: `建议 ${code} 已是已采纳状态，仅更新评审时间 ${stamp}`,
        data: getSuggestionDetail(suggestionId).data,
      }
    }

    if (!ACTIVE_STATUSES.includes(text(row.status))) {
      return {
        ok: false,
        message: `建议 ${code} 当前状态为「${text(row.status)}」，不能采纳；请重新生成建议`,
      }
    }
    if (text(row['优化后查询']).trim() === '') {
      return { ok: false, message: `建议 ${code} 的优化后查询为空，不能作为执行依据` }
    }
    if (text(row['原始查询']).trim() === '') {
      return { ok: false, message: `建议 ${code} 缺少原始查询，无法逐项追溯` }
    }

    const checks = pendingChecksFor(row)
    const own = adoptedRewriteForSuggestion(rewrites, suggestionId)
    const rewriteCode = own?.rewriteCode ?? text(row['改写编号']) ?? ''
    const finalCode = rewriteCode || rewriteCodeFor(rewrites)
    const path = appendPath(row, {
      status: ADOPTED_STATUS,
      at: stamp,
      by: reviewer,
      note: checks.length
        ? `评审通过；${checks.join('、')}缺失，保留待核对`
        : '评审通过，设为当前执行版本',
    })
    const adoptedRow: EntryRow = {
      ...row,
      status: ADOPTED_STATUS,
      pending: false,
      abnormal: false,
      建议状态: ADOPTED_STATUS,
      评审人: reviewer,
      评审时间: stamp,
      改写编号: finalCode,
      待核对: JSON.stringify(checks),
      状态路径: JSON.stringify(path),
    }
    rows[index] = adoptedRow

    const catalogEntry = catalog.find((item) => item.queryId === text(adoptedRow['查询标识']))
    const record: QueryRewriteRecord = {
      rowId: suggestionId,
      rewriteCode: finalCode,
      queryId: text(adoptedRow['查询标识']),
      queryName: catalogEntry?.queryName ?? '',
      suggestionId,
      suggestionCode: code,
      originalQuery: text(adoptedRow['原始查询']) || catalogEntry?.originalQuery || '',
      rewrittenQuery: text(adoptedRow['优化后查询']),
      indexRef: text(adoptedRow['涉及索引']),
      partitionRef: text(adoptedRow['涉及分区']),
      status: ADOPTED_STATUS,
      reviewer,
      reviewedAt: stamp,
      adoptedAt: stamp,
      isCurrent: true,
      pendingChecks: checks,
      statusPath: path,
      sourceRecord: `优化建议 ${code} ← ${text(adoptedRow['来源记录']) || '未登记来源'}`,
      optimizationType: text(adoptedRow['优化类型']),
      estimatedLift: liftOf(adoptedRow),
      generatedBy: text(adoptedRow['生成人']),
      generatedAt: text(adoptedRow['生成时间']),
    }

    const withoutOwn = rewrites.filter((item) => item.suggestionId !== suggestionId)
    let nextRewrites = own
      ? rewrites.map((item) => (item.suggestionId === suggestionId ? record : item))
      : [...withoutOwn, record]
    nextRewrites = normalizeCurrent(nextRewrites)

    saveRows(QUERY_OPT, rows)
    saveRewrites(nextRewrites)
    saveCatalog(
      catalog.map((entryItem) => {
        const current = nextRewrites.find((item) => item.queryId === entryItem.queryId && item.isCurrent)
        return {
          ...entryItem,
          currentSuggestionCode: current?.suggestionCode ?? '',
          currentRewriteCode: current?.rewriteCode ?? '',
        }
      }),
    )
    syncEvaluationLinks(nextRewrites, loadCatalog(), stamp)
    return {
      ok: true,
      message: `建议 ${code} 已采纳，执行依据 ${finalCode} 唯一可评估`,
      data: getSuggestionDetail(suggestionId).data,
    }
  })
  if (locked === null) {
    return { ok: false, message: '该建议正在处理中，请稍后刷新查看结果' }
  }
  return locked as QueryOptResult<SuggestionDetail>
}

export function ignoreSuggestion(
  suggestionId: number,
  actor: { reviewer?: string; at?: string } = {},
): QueryOptResult<SuggestionDetail> {
  const locked = withLock(`queryopt:${suggestionId}`, () => {
    ensureQueryOptSchema()
    const reviewer = actor.reviewer?.trim() || '值班管理员'
    const stamp = nowStamp(actor.at)
    const rows = cloneRows(listRows(QUERY_OPT))
    const index = rows.findIndex((row) => Number(row.id) === suggestionId)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${suggestionId} 的优化建议` }
    }
    const row = rows[index]
    const code = text(row['建议编号'])
    if (text(row.status) === ADOPTED_STATUS) {
      return {
        ok: false,
        message: `建议 ${code} 是当前执行版本，不能直接忽略；请先采纳其他建议再忽略`,
      }
    }
    if (text(row.status) === IGNORED_STATUS) {
      return { ok: false, message: `建议 ${code} 已经是已忽略状态，原查询仍然保留` }
    }
    const updated: EntryRow = {
      ...row,
      status: IGNORED_STATUS,
      pending: false,
      abnormal: true,
      建议状态: IGNORED_STATUS,
      评审人: reviewer,
      评审时间: stamp,
      状态路径: JSON.stringify(
        appendPath(row, {
          status: IGNORED_STATUS,
          at: stamp,
          by: reviewer,
          note: '评审忽略；原查询与查询目录保留，不作为执行依据',
        }),
      ),
    }
    rows[index] = updated
    saveRows(QUERY_OPT, rows)
    // 忽略不会删除原查询，也不会动查询改写数据集中已采纳的版本。
    return {
      ok: true,
      message: `建议 ${code} 已忽略，原查询 ${text(row['查询标识'])} 仍保留`,
      data: getSuggestionDetail(suggestionId).data,
    }
  })
  if (locked === null) {
    return { ok: false, message: '该建议正在处理中，请稍后刷新查看结果' }
  }
  return locked as QueryOptResult<SuggestionDetail>
}

/* ------------------------------------------------------------------ */
/* 结果评估：只读取唯一已采纳版本，并保留来源                          */
/* ------------------------------------------------------------------ */

function syncEvaluationLinks(
  rewrites: QueryRewriteRecord[],
  catalog: QueryCatalogEntry[],
  stamp: string,
): string[] {
  const rows = cloneRows(listRows(RESULT_EVAL))
  const messages: string[] = []
  let changed = false
  const next = rows.map((row) => {
    const queryId = text(row['关联查询'])
    const current = currentRewriteFrom(rewrites, queryId)
    if (!current) {
      return row
    }
    if (text(row['改写编号']).trim() === '') {
      changed = true
      messages.push(`评估记录 ${text(row['记录编号'])} 已补链当前执行版本 ${current.rewriteCode}`)
      const recordedSuggestion = text(row['建议编号'])
      return {
        ...row,
        改写编号: current.rewriteCode,
        // 原有建议编号保留在来源记录里，不被当前版本冲掉。
        来源记录: `${text(row['来源记录']) || `评估来源建议 ${recordedSuggestion || '未登记'}`}；评估记录 ${text(row['记录编号'])} 于 ${stamp} 补链 ${current.rewriteCode}（建议 ${current.suggestionCode}）`,
      }
    }
    return row
  })
  if (changed) {
    saveRows(RESULT_EVAL, next)
  }
  const missing = next.filter((row) => {
    const queryId = text(row['关联查询'])
    return currentRewriteFrom(rewrites, queryId) === null
  })
  for (const row of missing) {
    messages.push(`评估记录 ${text(row['记录编号'])} 关联查询 ${text(row['关联查询'])} 尚无唯一已采纳版本，保留待核对`)
  }
  return messages
}

export function listEvaluations(): EvaluationView[] {
  ensureQueryOptSchema()
  const rewrites = loadRewrites()
  return listRows(RESULT_EVAL).map((row) => {
    const queryId = text(row['关联查询'])
    const current = currentRewriteFrom(rewrites, queryId)
    const recordedCode = text(row['改写编号'])
    const recorded = recordedCode ? rewrites.find((item) => item.rewriteCode === recordedCode) : undefined
    let linkState: EvaluationLinkState = '待核对'
    let linkMessage = '该查询尚无唯一已采纳版本，评估入口保持待核对'
    if (current) {
      if (recorded === undefined || recordedCode === '') {
        linkState = '待核对'
        linkMessage = `评估记录尚未绑定执行依据，当前可读取 ${current.rewriteCode}`
      } else if (recordedCode === current.rewriteCode) {
        linkState = '当前版本'
        linkMessage = `读取唯一已采纳版本 ${current.rewriteCode}（建议 ${current.suggestionCode}）`
      } else {
        linkState = '历史版本'
        linkMessage = `记录来源为 ${recordedCode}，当前执行版本为 ${current.rewriteCode}，评估以当前版本为准`
      }
    } else if (recorded) {
      linkState = '历史版本'
      linkMessage = `来源 ${recorded.rewriteCode} 已不是当前执行版本，且该查询暂无唯一已采纳版本`
    }
    const basis = current ?? (recorded ?? null)
    return {
      rowId: Number(row.id),
      code: text(row['记录编号']),
      queryId,
      suggestionCode: current?.suggestionCode ?? text(row['建议编号']),
      rewriteCode: current?.rewriteCode ?? recordedCode,
      recordedSuggestionCode: text(row['建议编号']),
      recordedRewriteCode: recordedCode,
      sourceRecord: text(row['来源记录']),
      accuracy: text(row['结果准确性']),
      completeness: text(row['数据完整性']),
      speed: text(row['响应速度评分']),
      abnormal: text(row['是否异常']),
      note: text(row['评估备注']),
      evaluatedAt: text(row['评估时间']),
      status: text(row.status),
      rewrite: current,
      linkState,
      linkMessage,
      diff: basis ? diffQuery(basis.originalQuery, basis.rewrittenQuery) : [],
    }
  })
}

export function runEvaluationAction(
  rowId: number,
  action: string,
  actor: { reviewer?: string; at?: string } = {},
): QueryOptResult<EvaluationView> {
  ensureQueryOptSchema()
  const meta = MODULE_BY_KEY.get(RESULT_EVAL)
  if (!meta) {
    return { ok: false, message: '没有登记名为 resulteval 的业务模块' }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = cloneRows(listRows(RESULT_EVAL))
  const index = rows.findIndex((row) => Number(row.id) === rowId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${rowId} 的${meta.entity}` }
  }
  const row = rows[index]
  const code = text(row['记录编号'])
  if (text(row.status) === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const rewrites = loadRewrites()
  const current = currentRewriteFrom(rewrites, text(row['关联查询']))
  if (action === '确认评估' && !current) {
    return {
      ok: false,
      message: `${code} 关联查询 ${text(row['关联查询'])} 尚无唯一已采纳版本，不能确认评估；请保留为待核对`,
    }
  }
  const stamp = nowStamp(actor.at)
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== '已归档' && target !== '已评估',
    abnormal: false,
    评估人: actor.reviewer?.trim() || text(row['评估人']) || '值班管理员',
    评估时间: stamp,
  }
  if (current) {
    updated['建议编号'] = current.suggestionCode
    updated['改写编号'] = current.rewriteCode
    updated['来源记录'] = `${current.sourceRecord}；评估记录 ${code}`
  }
  rows[index] = updated
  saveRows(RESULT_EVAL, rows)
  const view = listEvaluations().find((item) => item.rowId === rowId)
  return { ok: true, message: `${meta.entity}${code} 已${action}，当前状态「${target}」`, data: view }
}

export function exportRewriteDatasetCsv(): { filename: string; content: string } {
  ensureQueryOptSchema()
  const rewrites = loadRewrites()
  const header = [
    '改写编号',
    '查询标识',
    '查询名称',
    '建议编号',
    '原始查询',
    '优化后查询',
    '优化类型',
    '预估提升',
    '涉及索引',
    '涉及分区',
    '建议状态',
    '评审人',
    '评审时间',
    '是否当前版本',
    '待核对',
    '状态路径',
    '来源记录',
  ]
  const escape = (value: unknown) => `"${text(value).replace(/"/g, '""')}"`
  const lines = [header.join(',')]
  for (const record of rewrites) {
    lines.push(
      [
        record.rewriteCode,
        record.queryId,
        record.queryName,
        record.suggestionCode,
        record.originalQuery,
        record.rewrittenQuery,
        record.optimizationType,
        record.estimatedLift,
        record.indexRef,
        record.partitionRef,
        record.status,
        record.reviewer,
        record.reviewedAt,
        record.isCurrent ? '是' : '否',
        record.pendingChecks.join('|'),
        JSON.stringify(record.statusPath),
        record.sourceRecord,
      ]
        .map(escape)
        .join(','),
    )
  }
  return { filename: '查询改写数据集.csv', content: `﻿${lines.join('\n')}` }
}

export function downloadRewriteDataset(): void {
  const { filename, content } = exportRewriteDatasetCsv()
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

/** 应用启动时调用：修掉旧结构，并把已采纳建议补写进查询改写数据集。 */
export function bootstrapQueryOptData(): RewriteDatasetReport {
  ensureQueryOptSchema()
  return generateRewriteDataset()
}

export function resetQueryOptData(): RewriteDatasetReport {
  // 重置也走同一套生成流程，保证「建议表 + 改写数据集」一致可读。
  resetQueryOptModule()
  resetResultEvalModule()
  return generateRewriteDataset()
}
