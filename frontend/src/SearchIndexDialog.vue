<script setup>
import { computed, inject, reactive, ref } from 'vue'
import { Plus, Search, Trash2, X } from '@lucide/vue'
import { command } from './api.js'
import { buildIndex, commandText, fieldTypes, inferFields } from './search.js'

const props = defineProps({ tab: Object, connection: Object })
const emit = defineEmits(['close', 'created'])
const tr = inject('tr')
const sampleKey = ref('')
const draft = reactive({ name: '', source: 'HASH', prefix: '', fields: [] })
const busy = ref(false)
const error = ref('')
const preview = computed(() => {
  try {
    return commandText(buildIndex(draft))
  } catch {
    return ''
  }
})

/** Run index commands against the database selected when the search tab opened. */
function run(...args) {
  return command(props.tab.connection, props.tab.db, ...args)
}

/** Infer an editable schema from one existing Hash or JSON key. */
async function inspectKey() {
  if (busy.value || !sampleKey.value) return
  busy.value = true
  error.value = ''
  const key = sampleKey.value
  try {
    const type = await run('TYPE', key)
    const source = type === 'hash' ? 'HASH' : type === 'ReJSON-RL' || type === 'json' ? 'JSON' : ''
    if (!source) {
      error.value = tr('请输入一个已有的 Hash 或 JSON 键。', 'Enter an existing Hash or JSON key.')
      return
    }
    const reply = await run(source === 'HASH' ? 'HGETALL' : 'JSON.GET', key)
    const fields = inferFields(source, reply)
    draft.source = source
    draft.fields = fields
    if (!draft.prefix) {
      const separator = props.connection.separator || ':'
      const last = key.lastIndexOf(separator)
      draft.prefix = last < 0 ? key : key.slice(0, last + separator.length)
    }
    if (!fields.length) error.value = tr('这个键没有可推断的标量字段，可以手动添加。', 'This key has no scalar fields to infer. Add fields manually.')
  } catch (failure) {
    error.value = failure.message
  } finally {
    busy.value = false
  }
}

/** Add a schema field with the usual vector options available when its type changes. */
function appendField() {
  draft.fields.push({ name: '', alias: '', type: 'TEXT', sortable: false, algorithm: 'FLAT', dimensions: '', metric: 'COSINE' })
}

/** Create only the index; the source documents stay unchanged. */
async function create() {
  if (busy.value || props.connection.readOnly) return
  error.value = ''
  busy.value = true
  try {
    const args = buildIndex(draft)
    await run(...args)
    emit('created', args[1])
  } catch (failure) {
    error.value = failure.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <WorkspaceDialog @close="!busy && emit('close')">
    <form class="modal wide-modal" aria-modal="true" aria-labelledby="search-index-title" role="dialog" @submit.prevent="create">
      <header class="modal-header">
        <h2 id="search-index-title">{{ tr('创建搜索索引', 'Create search index') }}</h2>
        <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭', 'Close')" :disabled="busy" @click="emit('close')"><X :size="19" /></NButton>
      </header>
      <div class="modal-body">
        <div class="index-source">
          <label>{{ tr('现有 Hash 或 JSON 键', 'Existing Hash or JSON key') }}
            <NInput v-model:value="sampleKey" :disabled="busy" :input-props="{ 'aria-label': tr('示例键', 'Example key'), spellcheck: false }"
              :placeholder="tr('输入完整键名', 'Enter the full key name')" @keydown.enter.prevent="inspectKey" />
          </label>
          <NButton :disabled="busy || !sampleKey" @click="inspectKey"><Search :size="15" />{{ tr('推断字段', 'Infer fields') }}</NButton>
        </div>
        <div class="form-grid">
          <label>{{ tr('索引名称', 'Index name') }}
            <NInput v-model:value="draft.name" :disabled="busy" :placeholder="'idx:products'" :input-props="{ 'aria-label': tr('索引名称', 'Index name') }" />
          </label>
          <label>{{ tr('数据类型', 'Source type') }}
            <select v-model="draft.source" :disabled="busy" @change="draft.fields = []"><option>HASH</option><option>JSON</option></select>
          </label>
          <label class="index-prefix">{{ tr('键前缀', 'Key prefix') }}
            <NInput v-model:value="draft.prefix" :disabled="busy" :placeholder="'products:'" :input-props="{ 'aria-label': tr('键前缀', 'Key prefix'), spellcheck: false }" />
          </label>
        </div>
        <div class="index-schema">
          <header class="row-tools">
            <strong>{{ tr('索引字段', 'Schema fields') }}</strong>
            <span class="spacer"></span>
            <NButton size="small" :disabled="busy" @click="appendField"><Plus :size="15" />{{ tr('添加字段', 'Add field') }}</NButton>
          </header>
          <template v-for="(field, i) in draft.fields" :key="i">
            <div class="index-field">
              <NInput v-model:value="field.name" size="small" :disabled="busy" :placeholder="draft.source === 'JSON' ? '$.field' : tr('字段名', 'Field name')"
                :input-props="{ 'aria-label': tr('字段路径', 'Field path') + ' ' + (i + 1), spellcheck: false }" />
              <NInput v-model:value="field.alias" size="small" :disabled="busy" :placeholder="tr('别名', 'Alias')"
                :input-props="{ 'aria-label': tr('字段别名', 'Field alias') + ' ' + (i + 1), spellcheck: false }" />
              <select v-model="field.type" :disabled="busy" :aria-label="tr('字段类型', 'Field type') + ' ' + (i + 1)">
                <option v-for="name in fieldTypes" :key="name">{{ name }}</option>
              </select>
              <label v-if="field.type !== 'VECTOR'" class="soft-check"><input v-model="field.sortable" type="checkbox" :disabled="busy"> {{ tr('排序', 'Sortable') }}</label>
              <span v-else class="muted">FLOAT32</span>
              <NButton size="small" type="error" quaternary class="flat icon" :disabled="busy" :aria-label="tr('移除字段', 'Remove field') + ' ' + (i + 1)" @click="draft.fields.splice(i, 1)"><Trash2 :size="15" /></NButton>
            </div>
            <div v-if="field.type === 'VECTOR'" class="row-tools index-vector">
              <select :value="field.algorithm || 'FLAT'" :disabled="busy" :aria-label="tr('向量算法', 'Vector algorithm')" @change="field.algorithm = $event.target.value">
                <option value="FLAT">FLAT</option><option value="HNSW">HNSW</option>
              </select>
              <label>{{ tr('维度', 'Dimensions') }} <input v-model.number="field.dimensions" type="number" min="1" step="1" :disabled="busy"></label>
              <select :value="field.metric || 'COSINE'" :disabled="busy" :aria-label="tr('距离度量', 'Distance metric')" @change="field.metric = $event.target.value">
                <option value="COSINE">COSINE</option><option value="L2">L2</option><option value="IP">IP</option>
              </select>
            </div>
          </template>
        </div>
        <NAlert v-if="error" type="error">{{ error }}</NAlert>
        <details v-if="preview">
          <summary>{{ tr('命令预览', 'Command preview') }}</summary>
          <pre class="index-preview">{{ preview }}</pre>
        </details>
      </div>
      <footer class="modal-footer end">
        <NButton :disabled="busy" @click="emit('close')">{{ tr('取消', 'Cancel') }}</NButton>
        <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !preview || connection.readOnly">{{ tr('创建索引', 'Create index') }}</NButton>
      </footer>
    </form>
  </WorkspaceDialog>
</template>

<style scoped>
.index-source { display: flex; align-items: end; gap: 8px; }
.index-source label { display: grid; gap: 5px; flex: 1; min-width: 0; }
.index-prefix { grid-column: 1 / -1; }
.index-schema { display: grid; gap: 6px; }
.index-field { display: grid; grid-template-columns: minmax(80px, 1.3fr) minmax(65px, 1fr) auto auto auto; align-items: center; gap: 7px; }
.index-field select, .index-vector select, .index-vector input { min-height: 28px; padding-block: 3px; }
.index-vector { margin: 0 0 5px 12px; }
.index-vector input { width: 95px; }
.index-preview { white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px 0; }
</style>
