<template>
  <section class="page" data-module="queryopt">
    <header class="page-head">
      <div>
        <h2>查询优化管理</h2>
        <p class="page-desc">
          一条查询可以并存多条建议；只有一条「当前执行版本」能进入评估，原查询、改写查询、索引与分区逐项留痕。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记优化建议</button>
        <button class="btn" type="button" @click="runDatasetCheck">校验并生成查询改写数据集</button>
        <button class="btn" type="button" @click="exportDataset">导出查询改写数据集</button>
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
      <span class="legend-item">当前执行版本：{{ currentVersionCount }}</span>
    </p>

    <p v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</p>
    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <section class="panel">
      <header class="panel-head">
        <h3>查询与建议分组</h3>
        <span class="panel-hint">左侧选中一条查询，右侧只展示该查询的建议；其余建议保留，不冒充当前执行版本。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>查询标识</th>
            <th>查询名称</th>
            <th>原查询</th>
            <th>建议数</th>
            <th>已采纳</th>
            <th>待评审</th>
            <th>已忽略</th>
            <th>当前执行版本</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="group in groups"
            :key="group.queryId"
            :class="{ selected: group.queryId === selectedQueryId }"
          >
            <td>{{ group.queryId }}</td>
            <td>{{ group.queryName }}</td>
            <td class="query-cell" :title="group.originalQuery">{{ group.originalQuery }}</td>
            <td>{{ group.suggestionCount }}</td>
            <td>{{ group.adoptedCount }}</td>
            <td>{{ group.pendingCount }}</td>
            <td>{{ group.ignoredCount }}</td>
            <td>
              <template v-if="group.currentRewriteCode">
                <span class="badge badge-current">{{ group.currentSuggestionCode }}</span>
                <span class="muted-text">{{ group.currentRewriteCode }}</span>
              </template>
              <span v-else class="badge badge-muted">未采纳</span>
            </td>
            <td>
              <button class="link" type="button" @click="selectQuery(group.queryId)">查看建议</button>
            </td>
          </tr>
          <tr v-if="!groups.length">
            <td colspan="9" class="empty-state">暂无查询优化数据，可先登记优化建议</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <header class="panel-head">
        <h3>优化建议（{{ selectedQueryName || selectedQueryId || '未选择查询' }}）</h3>
        <span class="panel-hint">同一查询的多份建议并存；采纳绑定具体改写查询、索引和分区。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>建议编号</th>
            <th>建议状态</th>
            <th>优化类型</th>
            <th>预估提升</th>
            <th>涉及索引</th>
            <th>涉及分区</th>
            <th>评审人 / 时间</th>
            <th>当前版本</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in visibleSuggestions"
            :key="row.id"
            :class="{ selected: detail && detail.suggestion.id === row.id }"
          >
            <td>{{ row.code }}</td>
            <td>
              <span class="badge" :class="statusClass(row.status)">{{ row.status }}</span>
            </td>
            <td>{{ row.optimizationType || '—' }}</td>
            <td>{{ row.estimatedLiftText }}</td>
            <td>
              <span v-if="row.indexRef">{{ row.indexRef }}</span>
              <span v-else class="badge badge-warn">待核对</span>
            </td>
            <td>
              <span v-if="row.partitionRef">{{ row.partitionRef }}</span>
              <span v-else class="badge badge-warn">待核对</span>
            </td>
            <td>{{ row.reviewer || '—' }}<br /><span class="muted-text">{{ row.reviewedAt || '未评审' }}</span></td>
            <td>
              <span v-if="row.isCurrent" class="badge badge-current">唯一执行版本</span>
              <span v-else-if="row.adoptedRewrite" class="badge badge-muted">历史已采纳</span>
              <span v-else class="muted-text">—</span>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="openDetail(row.id)">详情</button>
              <button
                class="link"
                type="button"
                :disabled="!canAdopt(row)"
                :title="adoptHint(row)"
                @click="adopt(row.id)"
              >
                采纳建议
              </button>
              <button
                class="link"
                type="button"
                :disabled="!canIgnore(row)"
                :title="ignoreHint(row)"
                @click="ignore(row.id)"
              >
                忽略建议
              </button>
            </td>
          </tr>
          <tr v-if="!visibleSuggestions.length">
            <td colspan="9" class="empty-state">该查询还没有优化建议，可点右上角登记</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="detail" class="panel detail-panel">
      <header class="panel-head">
        <h3>建议详情 · {{ detail.suggestion.code }}</h3>
        <div class="panel-head-actions">
          <span class="badge" :class="statusClass(detail.suggestion.status)">
            {{ detail.suggestion.status }}
          </span>
          <button class="btn ghost" type="button" @click="detail = null">关闭</button>
        </div>
      </header>

      <dl class="meta-grid">
        <div><dt>查询标识</dt><dd>{{ detail.suggestion.queryId }}</dd></div>
        <div><dt>查询名称</dt><dd>{{ detail.suggestion.queryName || '—' }}</dd></div>
        <div><dt>涉及索引</dt><dd>{{ detail.suggestion.indexRef || '待核对（不从其他建议补全）' }}</dd></div>
        <div><dt>涉及分区</dt><dd>{{ detail.suggestion.partitionRef || '待核对（不从其他建议补全）' }}</dd></div>
        <div><dt>评审人</dt><dd>{{ detail.suggestion.reviewer || '未评审' }}</dd></div>
        <div><dt>评审时间</dt><dd>{{ detail.suggestion.reviewedAt || '未评审' }}</dd></div>
        <div><dt>来源记录</dt><dd>{{ detail.suggestion.sourceRecord || '未登记' }}</dd></div>
        <div><dt>生成依据</dt><dd>{{ detail.suggestion.generatedBy }} · {{ detail.suggestion.generatedAt }}</dd></div>
      </dl>

      <div class="diff-block">
        <h4>原查询 / 改写查询差异</h4>
        <pre class="sql-box"><template v-for="(segment, index) in detail.diff" :key="index"><span :class="`diff-${segment.type}`">{{ segment.text }}</span></template></pre>
      </div>

      <div class="diff-columns">
        <div>
          <h4>原查询</h4>
          <pre class="sql-box">{{ detail.suggestion.originalQuery || '—' }}</pre>
        </div>
        <div>
          <h4>改写查询</h4>
          <pre class="sql-box">{{ detail.suggestion.rewrittenQuery || '—' }}</pre>
        </div>
      </div>

      <div class="diff-columns">
        <div>
          <h4>状态路径</h4>
          <ol class="timeline">
            <li v-for="(step, index) in detail.suggestion.statusPath" :key="index">
              <span class="badge" :class="statusClass(step.status)">{{ step.status }}</span>
              <span class="muted-text">{{ step.at }} · {{ step.by }}</span>
              <p class="timeline-note">{{ step.note }}</p>
            </li>
          </ol>
        </div>
        <div>
          <h4>查询改写数据集中的执行依据</h4>
          <template v-if="detail.suggestion.adoptedRewrite">
            <p>
              改写编号 <strong>{{ detail.suggestion.adoptedRewrite.rewriteCode }}</strong>
              <span v-if="detail.suggestion.isCurrent" class="badge badge-current">当前执行版本</span>
              <span v-else class="badge badge-muted">历史版本</span>
            </p>
            <p class="muted-text">
              评审 {{ detail.suggestion.adoptedRewrite.reviewer }} ·
              {{ detail.suggestion.adoptedRewrite.reviewedAt }}
            </p>
            <p class="muted-text">来源：{{ detail.suggestion.adoptedRewrite.sourceRecord }}</p>
            <p v-if="detail.suggestion.adoptedRewrite.pendingChecks.length" class="badge badge-warn">
              待核对：{{ detail.suggestion.adoptedRewrite.pendingChecks.join('、') }}
            </p>
          </template>
          <p v-else class="muted-text">尚未进入查询改写数据集；采纳后才会生成执行依据。</p>
          <div v-if="detail.validationMessages.length" class="validation-box">
            <h4>校验结果</h4>
            <ul>
              <li v-for="message in detail.validationMessages" :key="message">{{ message }}</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head">
        <h3>查询改写数据集</h3>
        <span class="panel-hint">唯一当前版本直接供结果评估读取；历史已采纳版本保留，不参与当前评估。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>改写编号</th>
            <th>查询标识</th>
            <th>建议编号</th>
            <th>状态</th>
            <th>涉及索引</th>
            <th>涉及分区</th>
            <th>当前版本</th>
            <th>评审人 / 时间</th>
            <th>待核对</th>
            <th>来源记录</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in rewrites" :key="record.rewriteCode">
            <td>{{ record.rewriteCode }}</td>
            <td>{{ record.queryId }}</td>
            <td>{{ record.suggestionCode }}</td>
            <td><span class="badge" :class="statusClass(record.status)">{{ record.status }}</span></td>
            <td>{{ record.indexRef || '待核对' }}</td>
            <td>{{ record.partitionRef || '待核对' }}</td>
            <td>
              <span v-if="record.isCurrent" class="badge badge-current">是</span>
              <span v-else class="badge badge-muted">否</span>
            </td>
            <td>{{ record.reviewer }}<br /><span class="muted-text">{{ record.reviewedAt }}</span></td>
            <td>{{ record.pendingChecks.join('、') || '—' }}</td>
            <td class="muted-text">{{ record.sourceRecord }}</td>
          </tr>
          <tr v-if="!rewrites.length">
            <td colspan="10" class="empty-state">尚未生成查询改写数据集</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <header class="panel-head">
        <h3>校验缺口（{{ gaps.length }}）</h3>
        <span class="panel-hint">缺口只登记不回填；涉及索引/分区缺失时保持待核对。</span>
      </header>
      <ul class="gap-list">
        <li v-for="(gap, index) in gaps" :key="`${gap.suggestionCode}-${index}`">
          <span class="badge badge-warn">{{ gap.field }}</span>
          <strong>{{ gap.suggestionCode }}</strong>
          <span>{{ gap.message }}</span>
        </li>
        <li v-if="!gaps.length" class="muted-text">没有发现缺口。</li>
      </ul>
    </section>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <form class="modal" @submit.prevent="submitCreate">
        <header class="panel-head">
          <h3>登记优化建议</h3>
          <button class="btn ghost" type="button" @click="showCreate = false">关闭</button>
        </header>
        <p class="panel-hint">
          新草稿只新增一条待评审建议，不会覆盖已采纳版本或当前执行版本。
        </p>
        <div class="form-grid">
          <label>
            <span>查询标识</span>
            <input
              v-model="form.queryId"
              list="query-id-options"
              placeholder="选择已有查询或新建查询标识"
              @change="syncQueryForm"
            />
            <datalist id="query-id-options">
              <option v-for="group in groups" :key="group.queryId" :value="group.queryId">
                {{ group.queryName }}
              </option>
            </datalist>
          </label>
          <label>
            <span>查询名称</span>
            <input v-model="form.queryName" :disabled="Boolean(existingQuery)" placeholder="新建查询时必填" />
          </label>
          <label class="span-2">
            <span>原始查询</span>
            <textarea v-model="form.originalQuery" :disabled="Boolean(existingQuery)" rows="3" placeholder="新建查询时必填" />
          </label>
          <label class="span-2">
            <span>优化后查询</span>
            <textarea v-model="form.rewrittenQuery" rows="3" placeholder="必填；保存后与原查询逐项对照" />
          </label>
          <label>
            <span>优化类型</span>
            <input v-model="form.optimizationType" placeholder="如 分区裁剪" />
          </label>
          <label>
            <span>预估提升（%）</span>
            <input v-model.number="form.estimatedLift" type="number" step="0.1" min="0" />
          </label>
          <label>
            <span>涉及索引</span>
            <input v-model="form.indexRef" placeholder="留空则登记为待核对" />
          </label>
          <label>
            <span>涉及分区</span>
            <input v-model="form.partitionRef" placeholder="留空则登记为待核对" />
          </label>
          <label>
            <span>生成人</span>
            <input v-model="form.generatedBy" placeholder="默认 优化引擎" />
          </label>
          <label>
            <span>来源记录</span>
            <input v-model="form.sourceRecord" placeholder="如 查询历史 QH-0100" />
          </label>
        </div>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <footer class="modal-foot">
          <button class="btn primary" type="submit">生成建议</button>
        </footer>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ suggestions.length }} 条优化建议 · 当前执行版本 {{ currentVersionCount }} 份</span>
      <span>评估入口只读取唯一当前版本；历史版本与已忽略建议继续保留</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  adoptSuggestion,
  bootstrapQueryOptData,
  createSuggestion,
  downloadRewriteDataset,
  generateRewriteDataset,
  getSuggestionDetail,
  ignoreSuggestion,
  listQueryGroups,
  listSuggestions,
  validateSuggestions,
} from '@/api/query-opt-service'
import { loadRewrites } from '@/data/query-opt-store'
import type {
  QueryGroupView,
  QueryRewriteRecord,
  SuggestionDetail,
  SuggestionGap,
  SuggestionView,
} from '@/data/types'

const groups = ref<QueryGroupView[]>([])
const suggestions = ref<SuggestionView[]>([])
const rewrites = ref<QueryRewriteRecord[]>([])
const gaps = ref<SuggestionGap[]>([])
const selectedQueryId = ref('')
const detail = ref<SuggestionDetail | null>(null)
const errorMessage = ref('')
const noticeMessage = ref('')
const showCreate = ref(false)
const formError = ref('')

const form = reactive({
  queryId: '',
  queryName: '',
  originalQuery: '',
  rewrittenQuery: '',
  optimizationType: '分区裁剪',
  estimatedLift: 20,
  indexRef: '',
  partitionRef: '',
  generatedBy: '优化引擎',
  sourceRecord: '',
})

const existingQuery = computed(() => groups.value.find((group) => group.queryId === form.queryId) ?? null)

const selectedQueryName = computed(
  () => groups.value.find((group) => group.queryId === selectedQueryId.value)?.queryName ?? '',
)

const visibleSuggestions = computed(() =>
  suggestions.value.filter((item) => selectedQueryId.value === '' || item.queryId === selectedQueryId.value),
)

const currentVersionCount = computed(
  () => rewrites.value.filter((record) => record.isCurrent).length,
)

const stats = computed(() => [
  { label: '优化建议总数', value: suggestions.value.length },
  { label: '已采纳建议', value: suggestions.value.filter((item) => item.status === '已采纳').length },
  { label: '建议中数量', value: suggestions.value.filter((item) => item.status === '优化建议中' || item.status === '草稿').length },
])

const statusSummary = computed(() =>
  ['草稿', '优化建议中', '已采纳', '已忽略'].map((status) => ({
    status,
    count: suggestions.value.filter((item) => item.status === status).length,
  })),
)

function statusClass(status: string): string {
  if (status === '已采纳') {
    return 'badge-current'
  }
  if (status === '已忽略') {
    return 'badge-muted'
  }
  if (status === '优化建议中') {
    return 'badge-active'
  }
  return 'badge-warn'
}

function canAdopt(row: SuggestionView): boolean {
  return row.status === '草稿' || row.status === '优化建议中' || row.status === '已采纳'
}

function adoptHint(row: SuggestionView): string {
  if (row.status === '已忽略') {
    return '已忽略的建议不能直接采纳；请重新生成建议'
  }
  if (row.status === '已采纳') {
    return '重复采纳只更新评审时间，不新增第二份执行依据'
  }
  return '采纳后该建议成为唯一当前执行版本'
}

function canIgnore(row: SuggestionView): boolean {
  return row.status === '草稿' || row.status === '优化建议中'
}

function ignoreHint(row: SuggestionView): string {
  if (row.status === '已采纳') {
    return '当前执行版本不能直接忽略，请先采纳其他建议'
  }
  if (row.status === '已忽略') {
    return '已经是已忽略状态'
  }
  return '忽略不删除原查询，也不影响已采纳版本'
}

function reload() {
  groups.value = listQueryGroups()
  suggestions.value = listSuggestions()
  rewrites.value = loadRewrites()
  gaps.value = validateSuggestions()
  if (!selectedQueryId.value && groups.value.length) {
    selectedQueryId.value = groups.value[0].queryId
  }
  if (detail.value) {
    const refreshed = getSuggestionDetail(detail.value.suggestion.id)
    detail.value = refreshed.ok && refreshed.data ? refreshed.data : null
  }
}

function selectQuery(queryId: string) {
  selectedQueryId.value = queryId
  detail.value = null
}

function openDetail(suggestionId: number) {
  const result = getSuggestionDetail(suggestionId)
  if (!result.ok || !result.data) {
    errorMessage.value = result.message
    return
  }
  detail.value = result.data
}

function adopt(suggestionId: number) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = adoptSuggestion(suggestionId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function ignore(suggestionId: number) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = ignoreSuggestion(suggestionId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function runDatasetCheck() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const report = generateRewriteDataset()
  noticeMessage.value = `校验完成：建议 ${report.checkedSuggestions} 条，改写依据 ${report.checkedRewrites} 份，补写 ${report.repairedSuggestions}/${report.repairedRewrites} 项，缺口 ${report.gaps.length} 个`
  if (report.messages.length) {
    noticeMessage.value += `；${report.messages.join('；')}`
  }
  reload()
}

function exportDataset() {
  downloadRewriteDataset()
}

function syncQueryForm() {
  const entry = existingQuery.value
  if (entry) {
    form.queryName = entry.queryName
    form.originalQuery = entry.originalQuery
  }
  formError.value = ''
}

function openCreate() {
  form.queryId = selectedQueryId.value
  form.queryName = ''
  form.originalQuery = ''
  form.rewrittenQuery = ''
  form.optimizationType = '分区裁剪'
  form.estimatedLift = 20
  form.indexRef = ''
  form.partitionRef = ''
  form.generatedBy = '优化引擎'
  form.sourceRecord = ''
  formError.value = ''
  syncQueryForm()
  showCreate.value = true
}

function submitCreate() {
  formError.value = ''
  const draft = {
    queryId: form.queryId.trim(),
    queryName: form.queryName.trim(),
    originalQuery: form.originalQuery.trim(),
    rewrittenQuery: form.rewrittenQuery.trim(),
    optimizationType: form.optimizationType.trim(),
    estimatedLift: Number(form.estimatedLift),
    indexRef: form.indexRef.trim(),
    partitionRef: form.partitionRef.trim(),
    generatedBy: form.generatedBy.trim(),
    sourceRecord: form.sourceRecord.trim(),
  }
  if (!draft.queryId) {
    formError.value = '请填写查询标识'
    return
  }
  const result = createSuggestion(draft)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  showCreate.value = false
  selectedQueryId.value = draft.queryId
  noticeMessage.value = result.message
  reload()
}

onMounted(() => {
  // 启动时先核对缺口并补写执行依据，再渲染列表；已采纳内容不会被覆盖。
  bootstrapQueryOptData()
  reload()
})
</script>
