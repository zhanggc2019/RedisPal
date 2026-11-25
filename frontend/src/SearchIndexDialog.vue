<script setup>
import { computed, inject, reactive, ref, useId } from 'vue'
import { Plus, Search, Trash2, X } from '@lucide/vue'
import { command } from './api.js'
import { buildIndex, commandText, fieldTypes, inferFields } from './search.js'
import IconButton from './components/IconButton.vue'
import StatusNotice from './components/StatusNotice.vue'

const props = defineProps({ tab: Object, connection: Object })
const emit = defineEmits(['close', 'created'])
const tr = inject('tr')
const titleId = useId()
const sampleKey = ref('')
const draft = reactive({ name: '', source: 'HASH', prefix: '', fields: [] })
const busy = ref(false)
const error = ref('')
let nextFieldId = 0
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
    draft.fields = fields.map(field => ({ ...field, id: nextFieldId++ }))
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
  draft.fields.push({ id: nextFieldId++, name: '', alias: '', type: 'TEXT', sortable: false, algorithm: 'FLAT', dimensions: '', metric: 'COSINE' })
}

/** Create only the index; the source documents stay unchanged. */
async function create() {
  if (busy.value || props.connection.readOnly || !preview.value) return
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
  <WorkspaceDialog :title-id="titleId" :busy="busy" @close="emit('close')">
    <template #default="{ requestClose, closeDisabled }">
      <form class="modal wide-modal index-dialog" aria-modal="true" :aria-labelledby="titleId" role="dialog" @submit.prevent="create">
        <header class="modal-header">
          <h2 :id="titleId">{{ tr('创建搜索索引', 'Create search index') }}</h2>
          <IconButton :icon="X" :label="tr('关闭', 'Close')" :disabled="closeDisabled" @click="requestClose" />
        </header>
        <div class="modal-body">
          <StatusNotice v-if="connection.readOnly" tone="info" :text="tr('只读连接无法创建索引。', 'Index creation is unavailable on read-only connections.')" />
          <StatusNotice v-if="error" tone="error" :text="error" />
          <fieldset class="index-section">
            <legend>{{ tr('数据来源', 'Source') }}</legend>
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
          </fieldset>
          <fieldset class="index-section index-schema">
            <legend>{{ tr('索引字段', 'Schema fields') }}</legend>
            <div v-for="(field, i) in draft.fields" :key="field.id" class="index-field">
              <div class="index-field-controls">
                <NInput v-model:value="field.name" size="small" :disabled="busy" :placeholder="draft.source === 'JSON' ? '$.field' : tr('字段名', 'Field name')"
                  :input-props="{ 'aria-label': tr('字段路径', 'Field path') + ' ' + (i + 1), spellcheck: false }" />
                <NInput v-model:value="field.alias" size="small" :disabled="busy" :placeholder="tr('别名', 'Alias')"
                  :input-props="{ 'aria-label': tr('字段别名', 'Field alias') + ' ' + (i + 1), spellcheck: false }" />
                <select v-model="field.type" :disabled="busy" :aria-label="tr('字段类型', 'Field type') + ' ' + (i + 1)">
                  <option v-for="name in fieldTypes" :key="name">{{ name }}</option>
                </select>
                <label v-if="field.type !== 'VECTOR'" class="soft-check"><input v-model="field.sortable" type="checkbox" :disabled="busy"> {{ tr('排序', 'Sortable') }}</label>
                <span v-else class="muted">FLOAT32</span>
                <IconButton :icon="Trash2" danger :disabled="busy" :label="tr('移除字段', 'Remove field') + ' ' + (i + 1)" @click="draft.fields.splice(i, 1)" />
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
            </div>
            <div>
              <NButton size="small" :disabled="busy" @click="appendField"><Plus :size="15" aria-hidden="true" />{{ tr('添加字段', 'Add field') }}</NButton>
            </div>
          </fieldset>
          <fieldset v-if="preview" class="index-section">
            <legend>{{ tr('预览', 'Preview') }}</legend>
            <details>
              <summary>{{ tr('命令预览', 'Command preview') }}</summary>
              <pre class="index-preview">{{ preview }}</pre>
            </details>
          </fieldset>
        </div>
        <footer class="modal-footer end">
          <NButton :disabled="closeDisabled" @click="requestClose">{{ tr('取消', 'Cancel') }}</NButton>
          <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy || !preview || connection.readOnly">{{ tr('创建索引', 'Create index') }}</NButton>
        </footer>
      </form>
    </template>
  </WorkspaceDialog>
</template>

<style scoped>
.index-dialog { width: min(calc(100vw / var(--ui-scale, 1) - 24px), 720px); border-radius: 8px; }
.index-dialog .modal-header, .index-dialog .modal-footer { min-height: 0; padding: 8px 16px; }
.index-dialog .modal-header h2, .index-section legend { font-size: 14px; font-weight: 650; }
.index-dialog .modal-body { container: index-form / inline-size; padding: 12px 16px; }
.index-section { min-width: 0; padding: 12px; }
.index-source { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin-bottom: 12px; }
.index-source label { display: grid; gap: 4px; flex: 1 1 220px; min-width: 0; }
.index-prefix { grid-column: 1 / -1; }
.index-schema, .index-field, .index-field-controls { display: grid; gap: 8px; }
.index-field + .index-field { border-top: 1px solid var(--border); padding-top: 8px; }
.index-field-controls { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) auto auto auto; align-items: center; }
.index-field-controls > * { min-width: 0; }
.index-field-controls select, .index-vector select, .index-vector input { min-height: 28px; padding-block: 4px; }
.index-vector input { width: 88px; }
.index-preview { white-space: pre-wrap; overflow-wrap: anywhere; padding-top: 8px; font-size: 12px; }
@container index-form (max-width: 440px) {
  .index-field-controls { grid-template-columns: minmax(0, 1fr) auto auto; }
  .index-field-controls > :nth-child(-n+2), .index-section .form-grid > label { grid-column: 1 / -1; }
}
</style>
