<template>
  <section class="page" data-module="resulteval">
    <header class="page-head">
      <div>
        <h2>结果评估管理</h2>
        <p class="page-desc">
          评估入口只读取查询改写数据集中唯一的已采纳版本，并保留建议编号与来源记录；待评审、已忽略版本不参与当前评估。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新当前版本</button>
        <button class="btn" type="button" @click="exportRows">导出结果评估清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">当前版本可评估：{{ currentCount }}</span>
      <span class="legend-item">待核对：{{ pendingCheckCount }}</span>
    </p>

    <p v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</p>
    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <form class="filter-bar" @submit.prevent>
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>记录编号</th>
          <th>关联查询</th>
          <th>读取的执行依据</th>
          <th>建议编号</th>
          <th>记录原关联</th>
          <th>结果准确性</th>
          <th>数据完整性</th>
          <th>响应速度评分</th>
          <th>评估状态</th>
          <th>入口说明</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="row.rowId">
          <td>{{ row.code }}</td>
          <td>{{ row.queryId }}<br /><span class="muted-text">{{ queryName(row.queryId) }}</span></td>
          <td>
            <template v-if="row.rewrite">
              {{ row.rewrite.rewriteCode }}
              <span class="badge" :class="row.linkState === '当前版本' ? 'badge-current' : 'badge-warn'">
                {{ row.linkState }}
              </span>
            </template>
            <span v-else class="badge badge-warn">待核对</span>
          </td>
          <td>{{ row.suggestionCode || '—' }}</td>
          <td class="muted-text">
            {{ row.recordedSuggestionCode || '未登记' }} / {{ row.recordedRewriteCode || '未登记' }}
          </td>
          <td>{{ row.accuracy }}</td>
          <td>{{ row.completeness }}</td>
          <td>{{ row.speed }}</td>
          <td>{{ row.status }}</td>
          <td class="muted-text">{{ row.linkMessage }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">差异与来源</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="action === '确认评估' && !row.rewrite"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="11" class="empty-state">没有匹配的评估记录</td>
        </tr>
      </tbody>
    </table>

    <section v-if="detail" class="panel detail-panel">
      <header class="panel-head">
        <h3>评估依据 · {{ detail.code }}</h3>
        <div class="panel-head-actions">
          <span class="badge" :class="detail.linkState === '当前版本' ? 'badge-current' : 'badge-warn'">
            {{ detail.linkState }}
          </span>
          <button class="btn ghost" type="button" @click="detail = null">关闭</button>
        </div>
      </header>
      <p class="muted-text">{{ detail.linkMessage }}</p>

      <dl v-if="detail.rewrite" class="meta-grid">
        <div><dt>改写编号</dt><dd>{{ detail.rewrite.rewriteCode }}</dd></div>
        <div><dt>建议编号</dt><dd>{{ detail.rewrite.suggestionCode }}</dd></div>
        <div><dt>查询标识</dt><dd>{{ detail.rewrite.queryId }}</dd></div>
        <div><dt>涉及索引</dt><dd>{{ detail.rewrite.indexRef || '待核对' }}</dd></div>
        <div><dt>涉及分区</dt><dd>{{ detail.rewrite.partitionRef || '待核对（不从其他建议补全）' }}</dd></div>
        <div><dt>评审人</dt><dd>{{ detail.rewrite.reviewer }}</dd></div>
        <div><dt>评审时间</dt><dd>{{ detail.rewrite.reviewedAt }}</dd></div>
        <div><dt>来源记录</dt><dd>{{ detail.rewrite.sourceRecord }}</dd></div>
        <div><dt>评估记录来源</dt><dd>{{ detail.sourceRecord || '未登记' }}</dd></div>
        <div><dt>记录原关联</dt><dd>{{ detail.recordedSuggestionCode || '未登记' }} / {{ detail.recordedRewriteCode || '未登记' }}</dd></div>
      </dl>

      <div v-if="detail.rewrite" class="diff-columns">
        <div>
          <h4>原查询</h4>
          <pre class="sql-box">{{ detail.rewrite.originalQuery }}</pre>
        </div>
        <div>
          <h4>改写查询</h4>
          <pre class="sql-box">{{ detail.rewrite.rewrittenQuery }}</pre>
        </div>
      </div>

      <div v-if="detail.diff.length" class="diff-block">
        <h4>差异对照</h4>
        <pre class="sql-box"><template v-for="(segment, index) in detail.diff" :key="index"><span :class="`diff-${segment.type}`">{{ segment.text }}</span></template></pre>
      </div>

      <div v-if="detail.rewrite" class="validation-box">
        <h4>状态路径</h4>
        <ol class="timeline">
          <li v-for="(step, index) in detail.rewrite.statusPath" :key="index">
            <span class="badge">{{ step.status }}</span>
            <span class="muted-text">{{ step.at }} · {{ step.by }}</span>
            <p class="timeline-note">{{ step.note }}</p>
          </li>
        </ol>
      </div>
      <div v-else class="validation-box">
        <h4>待核对说明</h4>
        <p class="muted-text">{{ detail.linkMessage }}</p>
        <p class="muted-text">评估入口不会拿其他建议的改写查询或分区字段补全。</p>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条结果评估记录</span>
      <span>评估入口只读唯一已采纳版本，多条建议并存时其余保留但不冒充当前执行版本</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { bootstrapQueryOptData, listEvaluations, runEvaluationAction } from '@/api/query-opt-service'
import { listQueryGroups } from '@/api/query-opt-service'
import { downloadEntries } from '@/api/local-service'
import type { EvaluationView, QueryGroupView } from '@/data/types'

const metaKey = 'resulteval'
const actions = ['发起评估', '确认评估', '归档评估']
const filterFields = ['关联查询', '建议编号', '改写编号']

const rows = ref<EvaluationView[]>([])
const groups = ref<QueryGroupView[]>([])
const filters = ref<Record<string, string>>({ '关联查询': '', '建议编号': '', '改写编号': '' })
const detail = ref<EvaluationView | null>(null)
const errorMessage = ref('')
const noticeMessage = ref('')

const stats = computed(() => [
  { label: '评估记录总数', value: rows.value.length },
  { label: '已评估记录', value: rows.value.filter((item) => item.status === '已评估').length },
  { label: '评估中记录', value: rows.value.filter((item) => item.status === '评估中').length },
])

const statusSummary = computed(() =>
  ['草稿', '评估中', '已评估', '已归档'].map((status) => ({
    status,
    count: rows.value.filter((item) => item.status === status).length,
  })),
)

const currentCount = computed(() => rows.value.filter((item) => item.linkState === '当前版本').length)
const pendingCheckCount = computed(() => rows.value.filter((item) => item.linkState === '待核对').length)

const filteredRows = computed(() =>
  rows.value.filter((row) =>
    Object.entries(filters.value).every(([field, value]) => {
      if (!value.trim()) {
        return true
      }
      if (field === '关联查询') {
        return row.queryId.includes(value.trim())
      }
      if (field === '建议编号') {
        return row.suggestionCode.includes(value.trim())
      }
      return row.rewriteCode.includes(value.trim())
    }),
  ),
)

function queryName(queryId: string): string {
  return groups.value.find((group) => group.queryId === queryId)?.queryName ?? ''
}

function reload() {
  errorMessage.value = ''
  rows.value = listEvaluations()
  groups.value = listQueryGroups()
  if (detail.value) {
    detail.value = rows.value.find((item) => item.rowId === detail.value?.rowId) ?? null
  }
}

function openDetail(row: EvaluationView) {
  detail.value = row
}

function runAction(action: string, row: EvaluationView) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = runEvaluationAction(row.rowId, action)
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  noticeMessage.value = result.message
  reload()
}

function resetFilters() {
  filters.value = { '关联查询': '', '建议编号': '', '改写编号': '' }
}

function exportRows() {
  downloadEntries(metaKey)
}

onMounted(() => {
  // 与查询优化共用同一份数据：先补链，再读取唯一当前版本。
  bootstrapQueryOptData()
  reload()
})
</script>
