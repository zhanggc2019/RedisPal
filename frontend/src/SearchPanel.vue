<script setup>
import { computed, inject, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { Bookmark, BookmarkPlus, ListTree, Play, Plus, RefreshCw, Search, Trash2 } from '@lucide/vue'
import { command } from './api.js'
import { pretty } from './formats.js'
import { display, identity } from './model.js'
import { buildIndex, buildQuery, indexFields, infoFields, readRows } from './search.js'
import SearchIndexDialog from './SearchIndexDialog.vue'

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
const error = ref('')
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
  busy.value = true
  error.value = ''
  availability.value = ''
  try {
    const reply = await run('FT._LIST')
    indexes.value = reply.filter(name => typeof name === 'string').sort()
    const next = indexes.value.includes(preferred) ? preferred : indexes.value[0] || ''
    if (draft.index === next) await loadSchema(next)
    else draft.index = next
  } catch (failure) {
    const message = failure.message || String(failure)
    availability.value = /unknown command/i.test(message)
      ? tr('此连接的 Redis 服务端不支持 Redis Search（FT._LIST）。', 'This Redis server does not support Redis Search (FT._LIST).')
      : tr('读取搜索索引失败，请检查连接和 ACL 的 FT._LIST 权限。', 'Unable to list indexes. Check the connection and ACL permissions for FT._LIST.')
    error.value = message
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

/** Execute a read-only query or diagnostic and retain the raw reply for inspection. */
async function execute(action) {
  if (busy.value || !draft.index) return
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
  if (busy.value || props.connection.readOnly || availability.value) return
  const confirmed = await ask({
    title: tr('导入搜索示例', 'Load Search samples'),
    text: tr('将写入 3 个带唯一前缀的 JSON 示例键和一个搜索索引。', 'This writes three JSON sample keys with a unique prefix and creates a search index.'),
  })
  if (!confirmed) return
  const prefix = 'redispal-sample:' + crypto.randomUUID() + ':'
  const name = 'idx:' + prefix.slice(0, -1)
  const records = [
    { name: 'City bike', category: 'bicycle', price: 299 },
    { name: 'Road bike', category: 'bicycle', price: 599 },
    { name: 'Safety helmet', category: 'accessory', price: 59 },
  ]
  const keys = []
  busy.value = true
  error.value = ''
  try {
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
    busy.value = false
    return
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
    <header class="panel-heading">
      <div class="panel-title"><div class="eyebrow">{{ connection.name }} · DB {{ tab.db }}</div>
        <h1><Search :size="23" />Redis Search</h1>
      </div>
      <div class="heading-actions">
        <NButton size="small" :loading="busy" @click="refresh()"><RefreshCw :size="15" />{{ tr('刷新索引', 'Refresh indexes') }}</NButton>
        <NButton size="small" :disabled="busy || !!availability || connection.readOnly" @click="createExamples">{{ tr('导入示例', 'Load sample data') }}</NButton>
        <NButton size="small" type="primary" :disabled="busy || !!availability || connection.readOnly" @click="editorOpen = true"><Plus :size="15" />{{ tr('创建索引', 'Create index') }}</NButton>
      </div>
    </header>

    <NAlert v-if="availability" type="warning" :title="availability">{{ error }}</NAlert>
    <NAlert v-else-if="!indexes.length && !busy" type="info">{{ tr('当前没有搜索索引。', 'No search indexes yet.') }}</NAlert>

    <template v-if="indexes.length">
      <div class="search-toolbar">
        <label>{{ tr('索引', 'Index') }}
          <select v-model="draft.index" :disabled="busy" :aria-label="tr('选择索引', 'Select index')">
            <option v-for="name in indexes" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <NTag v-if="details.num_docs !== undefined" size="small" :bordered="false">{{ display(details.num_docs) }} {{ tr('个文档', 'documents') }}</NTag>
        <span class="spacer"></span>
        <NButton size="small" :aria-pressed="libraryOpen" @click="libraryOpen = !libraryOpen"><Bookmark :size="15" />{{ tr('查询收藏', 'Query library') }}</NButton>
      </div>

      <details v-if="schema || infoError" class="search-index-details">
        <summary><ListTree :size="14" />{{ tr('索引详情', 'Index details') }}</summary>
        <NAlert v-if="infoError" type="warning">{{ infoError }}</NAlert>
        <template v-else>
          <NTable v-if="fields.length" size="small" :bordered="false">
            <thead><tr><th>{{ tr('字段', 'Field') }}</th><th>{{ tr('路径', 'Path') }}</th><th>{{ tr('类型', 'Type') }}</th></tr></thead>
            <tbody><tr v-for="field in fields" :key="field.alias"><td>{{ field.alias }}</td><td class="mono">{{ display(field.name) }}</td><td>{{ field.type }}</td></tr></tbody>
          </NTable>
          <details><summary>FT.INFO</summary><pre class="search-raw">{{ pretty(schema) }}</pre></details>
        </template>
      </details>

      <NCard v-if="libraryOpen" size="small" :title="tr('查询收藏', 'Query library')">
        <p v-if="!library.length" class="muted">{{ tr('暂无收藏的查询。', 'No saved queries yet.') }}</p>
        <ul v-else class="search-library">
          <li v-for="item in library" :key="item.id">
            <NButton size="small" quaternary :disabled="busy" @click="loadQuery(item)">{{ item.name }}</NButton>
            <span class="muted mono">{{ item.index }}</span><span class="spacer"></span>
            <NButton size="small" type="error" quaternary class="flat icon" :title="tr('移除收藏', 'Remove saved query')" :aria-label="tr('移除收藏', 'Remove saved query') + ' ' + item.name"
              @click="storeLibrary(library.filter(entry => entry.id !== item.id))"><Trash2 :size="15" /></NButton>
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
              :input-props="{ 'aria-label': tr('查询表达式', 'Query expression'), spellcheck: false }" @keydown.ctrl.enter.prevent="execute('run')" />
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
    </template>

    <NAlert v-if="error && !availability" type="error">{{ error }}</NAlert>
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

    <SearchIndexDialog v-if="editorOpen" :tab="tab" :connection="connection" @close="editorOpen = false" @created="createdIndex" />
  </section>
</template>

<style scoped>
.search-workspace { gap: 12px; }
.search-toolbar, .search-toolbar label { display: flex; align-items: center; gap: 8px; }
.search-toolbar select { max-width: min(440px, 52vw); }
.search-index-details { border: 1px solid var(--border); border-radius: 9px; background: var(--panel); padding: 10px 12px; }
.search-index-details summary { cursor: pointer; }
.search-index-details summary svg { vertical-align: middle; margin-right: 4px; }
.search-index-details[open] > summary { margin-bottom: 8px; }
.search-editor { display: grid; gap: 9px; }
.search-editor label { display: grid; gap: 5px; }
.search-editor select { width: fit-content; }
.search-editor :deep(textarea), .search-editor :deep(input) { font-family: Consolas, monospace; }
.search-library { padding: 0; margin: 0; list-style: none; }
.search-library li { display: flex; align-items: center; gap: 6px; overflow-wrap: anywhere; }
.search-library li + li { border-top: 1px solid var(--border); }
.search-result-count { margin-bottom: 8px; }
.search-result-fields { margin: 0; display: grid; grid-template-columns: minmax(48px, auto) minmax(0, 1fr); column-gap: 10px; }
.search-result-fields dt, .search-result-fields dd { margin: 0; overflow-wrap: anywhere; }
.search-raw { max-height: 32rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
</style>
