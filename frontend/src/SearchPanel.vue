<script setup>
import { computed, inject, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { Bookmark, BookmarkPlus, ListTree, Play, Plus, RefreshCw, Search, Trash2 } from '@lucide/vue'
import { command } from './api.js'
import { pretty } from './formats.js'
import { display, identity } from './model.js'
import { buildIndex, buildQuery, indexFields, infoFields, readRows } from './search.js'
import SearchIndexDialog from './SearchIndexDialog.vue'
import EmptyState from './components/EmptyState.vue'
import IconButton from './components/IconButton.vue'
import PanelHeader from './components/PanelHeader.vue'
import StatusNotice from './components/StatusNotice.vue'

const props = defineProps({ tab: Object, connection: Object })
const emit = defineEmits(['open-key'])
const tr = inject('tr')
const ask = inject('ask')
const notify = inject('notify')
const indexes = ref([])
const draft = reactive({ index: '', mode: 'SEARCH', query: '*', options: '' })
const schema = ref(null)
const result = ref(null)
const busy = ref(false)
const availability = ref('')
const indexError = ref('')
const error = ref('')
const canWrite = computed(() => !busy.value && !props.connection.readOnly && !availability.value && !indexError.value)
const infoError = ref('')
const editorOpen = ref(false)
const libraryOpen = ref(false)
const queryInput = ref(null)
const libraryKey = 'redispal-search-library:' + props.tab.connection + ':' + props.tab.db
const library = ref(readLibrary())
const details = computed(() => infoFields(schema.value))
const fields = computed(() => indexFields(schema.value))
const suffix = computed(() => draft.query.match(/@((?:\\.|[\p{L}\p{N}_-])*)$/u)?.[1])
const matchingFields = computed(() => {
  if (suffix.value === undefined) return []
  const prefix = suffix.value.replace(/\\/g, '').toLocaleLowerCase()
  return fields.value.filter(field => field.alias.toLocaleLowerCase().startsWith(prefix)).slice(0, 8)
})
let schemaRevision = 0

/** Run Search operations on the database attached to this workspace tab. */
function run(...args) {
  return command(props.tab.connection, props.tab.db, ...args)
}

/** Recover the query library even if old preferences cannot be parsed. */
function readLibrary() {
  try {
    const saved = JSON.parse(localStorage.getItem(libraryKey) || '[]')
    if (Array.isArray(saved)) return saved.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' &&
      typeof item.index === 'string' && typeof item.query === 'string' && typeof item.options === 'string' &&
      ['SEARCH', 'AGGREGATE'].includes(item.mode))
  } catch { /* Recover with an empty library. */ }
  return []
}

/** Save the library atomically so the visible list matches stored preferences. */
function storeLibrary(items) {
  try {
    localStorage.setItem(libraryKey, JSON.stringify(items))
    library.value = items
  } catch (failure) {
    notify(failure, true)
  }
}

/** Discover indexes using FT._LIST and identify servers that lack Search. */
async function refresh(preferred = draft.index) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  availability.value = ''
  indexError.value = ''
  try {
    const reply = await run('FT._LIST')
    indexes.value = reply.filter(name => typeof name === 'string').sort()
    const next = indexes.value.includes(preferred) ? preferred : indexes.value[0] || ''
    if (draft.index === next) await loadSchema(next)
    else draft.index = next
  } catch (failure) {
    const message = failure.message || String(failure)
    if (/unknown command/i.test(message)) {
      availability.value = tr('此连接的 Redis 服务端不支持 Redis Search（FT._LIST）。', 'This Redis server does not support Redis Search (FT._LIST).')
    }
    indexError.value = message
    indexes.value = []
  } finally {
    busy.value = false
  }
}

/** Load the selected index without applying a response from an older selection. */
async function loadSchema(index) {
  const revision = ++schemaRevision
  schema.value = null
  infoError.value = ''
  if (!index) return
  try {
    const reply = await run('FT.INFO', index)
    if (schemaRevision === revision) schema.value = reply
  } catch (failure) {
    if (schemaRevision === revision) infoError.value = failure.message
  }
}

/** Complete the field reference at the end of the current query expression. */
function completeField(alias) {
  const escaped = alias.replace(/[^\p{L}\p{N}_]/gu, ch => '\\' + ch)
  draft.query = draft.query.slice(0, -(suffix.value.length + 1)) + '@' + escaped + ':'
  nextTick(() => queryInput.value?.focus())
}

/** Consume the query shortcut before it reaches the desktop window handler. */
function runSearchShortcut(event) {
  if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return
  event.preventDefault()
  event.stopPropagation()
  if (!event.isComposing && !event.repeat) execute('run')
}

/** Execute a read-only query or diagnostic and retain the raw reply for inspection. */
async function execute(action) {
  if (busy.value || !draft.index || !draft.query.trim()) return
  error.value = ''
  result.value = null
  busy.value = true
  try {
    const args = buildQuery(draft, action)
    const reply = await run(...args)
    result.value = {
      action,
      data: action === 'run' ? readRows(reply, draft.mode, args.slice(3)) : null,
      text: typeof reply === 'string' ? reply : pretty(reply),
    }
  } catch (failure) {
    error.value = failure.message
  } finally {
    busy.value = false
  }
}

/** Save a named query with its index, mode and options. */
async function saveQuery() {
  if (!draft.index || !draft.query.trim()) return
  const name = await ask({ title: tr('保存查询', 'Save query'), input: true, value: draft.query.trim().slice(0, 50) })
  if (!name?.trim()) return
  storeLibrary([{ id: crypto.randomUUID(), name: name.trim(), ...draft }, ...library.value].slice(0, 100))
  libraryOpen.value = true
}

/** Restore a saved query only when its original index is still available. */
function loadQuery(item) {
  if (!indexes.value.includes(item.index)) {
    notify(tr('找不到此查询的索引。', 'The index for this query is unavailable.'), true)
    return
  }
  Object.assign(draft, { index: item.index, mode: item.mode, query: item.query, options: item.options })
  result.value = null
}

/** Select an index once its creation succeeds. */
function createdIndex(name) {
  editorOpen.value = false
  refresh(name)
}

/** Install example JSON records without replacing existing keys. */
async function createExamples() {
  if (!canWrite.value) return
  const prefix = 'redispal-sample:' + crypto.randomUUID() + ':'
  const name = 'idx:' + prefix.slice(0, -1)
  const records = [
    { name: 'City bike', category: 'bicycle', price: 299 },
    { name: 'Road bike', category: 'bicycle', price: 599 },
    { name: 'Safety helmet', category: 'accessory', price: 59 },
  ]
  const keys = []
  busy.value = true
  try {
    const confirmed = await ask({
      title: tr('导入搜索示例', 'Load Search samples'),
      text: tr('将写入 3 个带唯一前缀的 JSON 示例键和一个搜索索引。', 'This writes three JSON sample keys with a unique prefix and creates a search index.'),
    })
    if (!confirmed || props.connection.readOnly) return
    error.value = ''
    for (let i = 0; i < records.length; i++) {
      const key = prefix + (i + 1)
      if (await run('JSON.SET', key, '$', JSON.stringify(records[i]), 'NX') !== 'OK') {
        throw new Error(tr('示例键已存在，导入已停止。', 'A sample key already exists. Import stopped.'))
      }
      keys.push(key)
    }
    const fields = [
      { name: '$.name', alias: 'name', type: 'TEXT' },
      { name: '$.category', alias: 'category', type: 'TAG' },
      { name: '$.price', alias: 'price', type: 'NUMERIC', sortable: true },
    ]
    await run(...buildIndex({ name, prefix, source: 'JSON', fields }))
  } catch (failure) {
    const cleanup = await Promise.allSettled(keys.map(key => run('DEL', key)))
    error.value = failure.message
    if (cleanup.some(item => item.status === 'rejected')) {
      error.value += ' · ' + tr('请检查是否残留此前缀的示例键', 'Check for remaining sample keys with this prefix') + ' ' + prefix
    }
    return
  } finally {
    busy.value = false
  }
  await refresh(name)
}

watch(() => draft.index, index => {
  result.value = null
  loadSchema(index)
})
onMounted(() => refresh())
</script>

<template>
  <section class="panel search-workspace" :aria-label="tr('搜索工作区', 'Search workspace')">
    <PanelHeader :icon="Search">
      <template #eyebrow>{{ connection.name }} · DB {{ tab.db }}</template>
      <template #title>Redis Search</template>
      <template #actions>
        <NButton size="small" :loading="busy" :disabled="busy" @click="refresh()"><RefreshCw :size="15" aria-hidden="true" />{{ tr('刷新索引', 'Refresh indexes') }}</NButton>
        <NButton size="small" :disabled="!canWrite" @click="createExamples">{{ tr('导入示例', 'Load sample data') }}</NButton>
        <NButton size="small" type="primary" :disabled="!canWrite" @click="canWrite && (editorOpen = true)"><Plus :size="15" aria-hidden="true" />{{ tr('创建索引', 'Create index') }}</NButton>
      </template>
    </PanelHeader>

    <StatusNotice v-if="connection.readOnly" tone="info" :title="tr('只读连接', 'Read-only connection')"
      :text="tr('可查询现有索引。创建索引和导入示例不可用。', 'You can query existing indexes. Index creation and sample imports are unavailable.')" />
    <StatusNotice v-if="availability" tone="warning" :title="availability" :text="indexError" />
    <StatusNotice v-else-if="indexError" tone="error" retry @retry="refresh()" :text="indexError"
      :title="tr('读取搜索索引失败，请检查连接和 ACL 的 FT._LIST 权限。', 'Unable to list indexes. Check the connection and ACL permissions for FT._LIST.')" />
    <StatusNotice v-else-if="busy && !indexes.length" tone="info" :text="tr('处理中…', 'Working…')" />
    <EmptyState v-else-if="!indexes.length" compact>{{ tr('当前没有搜索索引。', 'No search indexes yet.') }}</EmptyState>
    <StatusNotice v-if="error" tone="error" :text="error" />

    <div v-if="indexes.length" class="search-layout">
      <aside class="search-indexes" :aria-label="tr('搜索索引', 'Search indexes')">
        <div class="search-toolbar">
          <label>{{ tr('索引', 'Index') }}
            <select v-model="draft.index" :disabled="busy" :aria-label="tr('选择索引', 'Select index')">
              <option v-for="name in indexes" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <NTag v-if="details.num_docs !== undefined" size="small" :bordered="false">{{ display(details.num_docs) }} {{ tr('个文档', 'documents') }}</NTag>
          <NButton size="small" :aria-pressed="libraryOpen" @click="libraryOpen = !libraryOpen"><Bookmark :size="15" aria-hidden="true" />{{ tr('查询收藏', 'Query library') }}</NButton>
        </div>

        <details v-if="schema" class="search-index-details">
          <summary><ListTree :size="14" aria-hidden="true" />{{ tr('索引详情', 'Index details') }}</summary>
          <div v-if="fields.length" class="table-wrap">
            <NTable size="small" :bordered="false">
              <thead><tr><th>{{ tr('字段', 'Field') }}</th><th>{{ tr('路径', 'Path') }}</th><th>{{ tr('类型', 'Type') }}</th></tr></thead>
              <tbody><tr v-for="field in fields" :key="field.alias"><td>{{ field.alias }}</td><td class="mono">{{ display(field.name) }}</td><td>{{ field.type }}</td></tr></tbody>
            </NTable>
          </div>
          <details><summary>FT.INFO</summary><pre class="search-raw">{{ pretty(schema) }}</pre></details>
        </details>
        <StatusNotice v-if="infoError" tone="error" :text="infoError" :retry="!busy" @retry="loadSchema(draft.index)" />
      </aside>

      <div class="search-main">
        <NCard v-if="libraryOpen" size="small" :title="tr('查询收藏', 'Query library')">
          <p v-if="!library.length" class="muted">{{ tr('暂无收藏的查询。', 'No saved queries yet.') }}</p>
          <ul v-else class="search-library">
            <li v-for="item in library" :key="item.id">
              <NButton size="small" quaternary :disabled="busy" @click="loadQuery(item)">{{ item.name }}</NButton>
              <span class="muted mono">{{ item.index }}</span>
              <IconButton :icon="Trash2" danger :label="tr('移除收藏', 'Remove saved query') + ' ' + item.name"
                @click="storeLibrary(library.filter(entry => entry.id !== item.id))" />
            </li>
          </ul>
        </NCard>

        <NCard size="small">
          <form class="search-editor" @submit.prevent="execute('run')">
            <label>{{ tr('查询命令', 'Query command') }}
              <select v-model="draft.mode" :disabled="busy">
                <option value="SEARCH">FT.SEARCH</option><option value="AGGREGATE">FT.AGGREGATE</option>
              </select>
            </label>
            <label>{{ tr('查询表达式', 'Query expression') }}
              <NInput ref="queryInput" v-model:value="draft.query" type="textarea" :rows="2" :disabled="busy" placeholder="@price:[0 100]"
                :input-props="{ 'aria-label': tr('查询表达式', 'Query expression'), spellcheck: false }" @keydown="runSearchShortcut" />
            </label>
            <div v-if="matchingFields.length" class="row-tools" :aria-label="tr('索引字段补全', 'Index field suggestions')">
              <NButton v-for="field in matchingFields" :key="field.alias" size="tiny" :disabled="busy" @click="completeField(field.alias)">@{{ field.alias }} · {{ field.type }}</NButton>
            </div>
            <label>{{ tr('命令选项', 'Command options') }}
              <NInput v-model:value="draft.options" :disabled="busy" :placeholder="draft.mode === 'SEARCH' ? 'LIMIT 0 20' : 'GROUPBY 1 @category REDUCE COUNT 0 AS total'"
                :input-props="{ 'aria-label': tr('命令选项', 'Command options'), spellcheck: false }" />
            </label>
            <div class="row-tools">
              <NButton size="small" type="primary" attr-type="submit" :disabled="busy || !draft.query.trim()"><Play :size="15" />{{ tr('运行查询', 'Run query') }}</NButton>
              <NButton size="small" :disabled="busy || !draft.query.trim()" @click="execute('explain')">Explain</NButton>
              <NButton size="small" :disabled="busy || !draft.query.trim()" @click="execute('profile')">Profile</NButton>
              <NButton size="small" :disabled="busy || !draft.query.trim()" @click="saveQuery"><BookmarkPlus :size="15" />{{ tr('保存查询', 'Save query') }}</NButton>
            </div>
          </form>
        </NCard>

        <NCard v-if="result" size="small" :title="result.action === 'run' ? tr('查询结果', 'Query results') : result.action === 'profile' ? 'Profile' : 'Explain'">
          <template v-if="result.data">
            <p class="muted search-result-count" role="status">{{ display(result.data.count) }} {{ tr('条匹配', 'matches') }} · {{ result.data.rows.length }} {{ tr('条返回', 'returned') }}</p>
            <div v-if="result.data.rows.length" class="table-wrap">
              <NTable size="small" :bordered="false">
                <thead><tr><th v-if="result.data.rows[0].key != null">{{ tr('键', 'Key') }}</th><th>{{ tr('字段', 'Fields') }}</th></tr></thead>
                <tbody>
                  <tr v-for="(row, i) in result.data.rows.slice(0, 200)" :key="row.key == null ? i : identity(row.key)">
                    <td v-if="row.key != null"><NButton text size="small" @click="emit('open-key', row.key)">{{ display(row.key) }}</NButton></td>
                    <td>
                      <dl v-if="row.fields.length" class="search-result-fields">
                        <template v-for="([name, value], j) in row.fields" :key="j">
                          <dt>{{ display(name) }}</dt><dd class="mono">{{ display(value) }}</dd>
                        </template>
                      </dl>
                    </td>
                  </tr>
                </tbody>
              </NTable>
            </div>
            <p v-if="result.data.rows.length > 200" class="muted">{{ tr('表格显示前 200 条，完整结果见原始响应。', 'The table shows the first 200 rows. See the raw response for all results.') }}</p>
            <details><summary>{{ tr('原始响应', 'Raw response') }}</summary><pre class="search-raw">{{ result.text }}</pre></details>
          </template>
          <pre v-else class="search-raw">{{ result.text }}</pre>
        </NCard>
      </div>
    </div>

    <SearchIndexDialog v-if="editorOpen" :tab="tab" :connection="connection" @close="editorOpen = false" @created="createdIndex" />
  </section>
</template>

<style scoped>
.search-workspace { container: search / inline-size; gap: 12px; padding: 16px; }
.search-workspace :deep(.shared-panel-header) { flex-wrap: wrap; }
.search-workspace :deep(.shared-panel-header__eyebrow) { overflow-wrap: anywhere; }
.search-workspace :deep(.shared-panel-header__actions) { flex-wrap: wrap; min-width: 0; max-width: 100%; }
.search-layout, .search-indexes, .search-main { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: 12px; min-width: 0; }
@media (min-width: 1025px) {
  @container search (min-width: 760px) {
    .search-layout { grid-template-columns: 240px minmax(0, 1fr); align-items: start; }
  }
}
.search-toolbar, .search-index-details { display: grid; justify-items: start; gap: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); padding: 12px; }
.search-toolbar label { display: grid; gap: 4px; width: 100%; }
.search-toolbar select { width: 100%; min-width: 0; text-overflow: ellipsis; }
.search-index-details { display: block; }
.search-index-details summary { cursor: pointer; }
.search-index-details summary svg { vertical-align: middle; margin-right: 4px; }
.search-index-details[open] > :not(:last-child) { margin-bottom: 8px; }
.search-main :deep(.n-card) { min-width: 0; border-radius: 6px; }
.table-wrap { border-radius: 6px; }
.table-wrap :deep(td) { overflow-wrap: anywhere; }
.search-editor { display: grid; gap: 8px; }
.search-editor label { display: grid; gap: 4px; min-width: 0; }
.search-editor select { width: fit-content; max-width: 100%; }
.search-editor :deep(textarea), .search-editor :deep(input) { font: 12px/1.55 Consolas, 'Cascadia Mono', monospace; }
.search-library { padding: 0; margin: 0; list-style: none; }
.search-library li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 8px; overflow-wrap: anywhere; }
.search-library li > :first-child { justify-self: start; }
.search-library li > :first-child, .search-editor .row-tools :deep(.n-button), .table-wrap :deep(.n-button) { max-width: 100%; height: auto; min-height: 28px; white-space: normal; text-align: start; }
.search-library :deep(.n-button__content), .search-editor .row-tools :deep(.n-button__content), .table-wrap :deep(.n-button__content) { min-width: 0; overflow-wrap: anywhere; }
.search-library li + li { border-top: 1px solid var(--border); }
.search-result-count { margin-bottom: 8px; }
.search-result-fields { margin: 0; display: grid; grid-template-columns: minmax(48px, auto) minmax(0, 1fr); column-gap: 10px; }
.search-result-fields dt, .search-result-fields dd { margin: 0; overflow-wrap: anywhere; }
.search-raw { max-height: 32rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
</style>
