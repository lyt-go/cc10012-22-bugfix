import { listRows, saveRows } from './local-store'
import {
  QUERY_CATALOG_SEED,
  QUERY_OPT_ROWS_SEED,
  QUERY_REWRITE_SEED,
  RESULT_EVAL_ROWS_SEED,
} from './query-opt-seed'
import type { EntryRow, QueryCatalogEntry, QueryRewriteRecord } from './types'

// 查询改写数据集单独持久化：优化建议是「过程」，改写数据集是「执行依据」。
// 两者各自有键，刷新时不会互相覆盖，也不会因为列表接口返回而丢字段。
const CATALOG_KEY = 'data-explore-selfservice:query-catalog'
const REWRITE_KEY = 'data-explore-selfservice:query-rewrites'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function readJson<T>(key: string, fallback: T, isValid: (value: unknown) => boolean): T {
  if (!hasStorage()) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    writeJson(key, fallback)
    return clone(fallback)
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isValid(parsed)) {
      writeJson(key, fallback)
      return clone(fallback)
    }
    return parsed as T
  } catch {
    writeJson(key, fallback)
    return clone(fallback)
  }
}

function writeJson(key: string, value: unknown): void {
  if (hasStorage()) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

function isCatalog(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => item && typeof item === 'object')
}

function isRewrites(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => item && typeof item === 'object')
}

export function loadCatalog(): QueryCatalogEntry[] {
  return readJson(CATALOG_KEY, QUERY_CATALOG_SEED, isCatalog)
}

export function saveCatalog(entries: QueryCatalogEntry[]): void {
  writeJson(CATALOG_KEY, entries)
}

export function loadRewrites(): QueryRewriteRecord[] {
  return readJson(REWRITE_KEY, QUERY_REWRITE_SEED, isRewrites)
}

export function saveRewrites(records: QueryRewriteRecord[]): void {
  writeJson(REWRITE_KEY, records)
}

/**
 * 旧版本的建议行没有查询标识/状态路径，刷新后分区和改写查询会丢。
 * 这里按行原地补结构：只用该行自己的字段，查重键由原始查询文本决定，
 * 相同原查询的旧建议归到同一查询下。已在旧数据里的内容原样保留。
 */
function migrateLegacyRows(): void {
  const rows = listRows('queryopt')
  if (rows.length === 0) {
    return
  }
  const legacy = rows.some((row) => row['查询标识'] === undefined || row['状态路径'] === undefined)
  if (!legacy) {
    return
  }
  // 旧数据里没有查询目录和改写数据集：从空开始重建，避免示例数据的编号
  // 与旧建议行撞号后被误认成同一份执行依据。
  const catalog = hasStorage() && window.localStorage.getItem(CATALOG_KEY) ? loadCatalog() : []
  if (!hasStorage() || !window.localStorage.getItem(REWRITE_KEY)) {
    writeJson(REWRITE_KEY, [])
  }
  const stamp = '历史数据迁移'
  const migrated: EntryRow[] = rows.map((row, index) => {
    const original = String(row['原始查询'] ?? '')
    const matched = catalog.find((entry) => entry.originalQuery === original && original !== '')
    const queryId =
      String(row['查询标识'] ?? '') ||
      matched?.queryId ||
      `LEGACY-Q${String(index + 1).padStart(3, '0')}`
    if (!catalog.some((entry) => entry.queryId === queryId) && original !== '') {
      catalog.push({
        queryId,
        queryName: String(row['查询名称'] ?? `历史查询 ${queryId}`),
        originalQuery: original,
        datasource: '历史数据迁移',
        createdBy: String(row['生成人'] ?? '系统迁移'),
        createdAt: stamp,
        currentSuggestionCode: '',
        currentRewriteCode: '',
      })
    }
    const status = String(row.status ?? row['建议状态'] ?? '草稿')
    const reviewer = String(row['评审人'] ?? '')
    const reviewedAt = String(row['评审时间'] ?? '')
    const checks = ['涉及索引', '涉及分区'].filter((field) => String(row[field] ?? '').trim() === '')
    return {
      ...row,
      查询标识: queryId,
      建议编号: String(row['建议编号'] ?? `OPT-${String(index + 1).padStart(4, '0')}`),
      建议状态: status,
      评审人: reviewer,
      评审时间: reviewedAt,
      生成人: String(row['生成人'] ?? '系统迁移'),
      生成时间: String(row['生成时间'] ?? stamp),
      来源记录: String(row['来源记录'] ?? '旧版查询优化数据迁移'),
      改写编号: String(row['改写编号'] ?? ''),
      待核对: JSON.stringify(checks),
      状态路径: JSON.stringify([
        {
          status,
          at: reviewedAt || stamp,
          by: reviewer || '系统迁移',
          note: '旧版数据迁移补录，原字段原样保留',
        },
      ]),
    }
  })
  saveRows('queryopt', migrated)
  saveCatalog(catalog)

  const evalRows = listRows('resulteval')
  const legacyEval = evalRows.some((row) => row['建议编号'] === undefined || row['改写编号'] === undefined)
  if (legacyEval) {
    saveRows(
      'resulteval',
      evalRows.map((row) => ({
        ...row,
        建议编号: String(row['建议编号'] ?? ''),
        改写编号: String(row['改写编号'] ?? ''),
        关联查询名称: String(row['关联查询名称'] ?? ''),
        评估人: String(row['评估人'] ?? ''),
        来源记录: String(row['来源记录'] ?? '旧版评估记录迁移；关联查询未登记为查询标识，保留待核对'),
      })),
    )
  }
}

export function ensureQueryOptSchema(): void {
  migrateLegacyRows()
}

export function resetQueryOptModule(): void {
  saveRows('queryopt', clone(QUERY_OPT_ROWS_SEED))
  writeJson(CATALOG_KEY, QUERY_CATALOG_SEED)
  writeJson(REWRITE_KEY, QUERY_REWRITE_SEED)
}

export function resetResultEvalModule(): void {
  saveRows('resulteval', clone(RESULT_EVAL_ROWS_SEED))
}

export function cloneRows(rows: EntryRow[]): EntryRow[] {
  return clone(rows)
}
