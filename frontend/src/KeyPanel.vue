<script setup>
import { computed, inject, onMounted, onUnmounted, reactive, ref, shallowRef, useId, watch } from 'vue'
import { ChevronRight, Clock3, Copy, Download, Info, KeyRound, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from '@lucide/vue'
import IconButton from './components/IconButton.vue'
import PanelHeader from './components/PanelHeader.vue'
import StatusNotice from './components/StatusNotice.vue'
import { call, Clipboard, command } from './api.js'
import { asArg, display, download, fromBytes, identity, toBytes } from './model.js'
import { pretty } from './formats.js'
import { countRows, createKey, editRow, listedRows, redisTypes, removeRow, rowCommands, typeName } from './keydata.js'
import StreamGroups from './StreamGroups.vue'
import ValueEditor from './ValueEditor.vue'

const props = defineProps({ tab: Object, connection: Object, visible: Boolean })
const emit = defineEmits(['change', 'refresh-list', 'open-key', 'dirty'])
const tr = inject('tr')
const ask = inject('ask')
const confirmDiscard = inject('confirmDiscard', () => ask({
  title: tr('未保存修改', 'Unsaved changes'),
  text: tr('放弃当前修改？', 'Discard the current changes?'),
  confirmLabel: tr('放弃修改', 'Discard changes'),
  danger: true,
}))
const notify = inject('notify')
const isNew = props.tab.kind === 'new'
const key = props.tab.key
const snapshot = shallowRef(null)
const newType = ref('string')
const newValue = ref('')
const type = computed(() => isNew ? newType.value : snapshot.value?.type ?? '')
const value = computed(() => isNew ? newValue.value : snapshot.value?.value ?? null)
const rows = computed(() => snapshot.value?.rows ?? [])
const count = computed(() => snapshot.value?.count ?? null)
const next = computed(() => snapshot.value?.next ?? null)
const memory = computed(() => snapshot.value?.memory ?? null)
const loading = ref(!isNew)
const saving = ref(false)
const lockInputs = ref(false)
const guarding = ref(false)
const error = ref('')
const writeError = ref('')
const ttlDraft = ref(null)
const ttlWritePending = ref(false)
let ttlEdit = 0
const ttl = computed({
  get: () => ttlDraft.value ?? snapshot.value?.ttl ?? -1,
  set: next => {
    ttlEdit++
    ttlDraft.value = next === (snapshot.value?.ttl ?? -1) ? null : next
  },
})
const name = ref(isNew ? '' : display(key))
const binaryKey = ref(typeof key === 'object')
const filter = ref('')
const range = reactive({ from: '', to: '' })
const streamView = ref('entries')
const streamLive = ref(false)
const streamInterval = ref(2)
const editor = ref(null)
const rowEditor = ref(null)
const rowDialog = ref(null)
const extra = ref(null)
const defaultFields = { field: '', fieldHex: false, score: '0', index: '', prepend: false, attributes: '' }
const draft = reactive({ ...defaultFields })
const scope = props.tab.connection + ':' + props.tab.db + ':' + (key === undefined ? props.tab.id : identity(key))
const dialogId = useId()
const editorDirty = ref(false)
const editorRendering = ref(false)
const rowEditorDirty = ref(false)
const rowEditorRendering = ref(false)
const scalarType = ref('')
const fieldsDirty = computed(() => Object.keys(defaultFields).some(field => draft[field] !== defaultFields[field]))
const rowDirty = computed(() => Boolean(rowDialog.value && !rowDialog.value.view && (
  rowEditorDirty.value || Object.keys(defaultFields).some(field => rowDialog.value[field] !== rowDialog.value.baseline[field])
)))
const dirty = computed(() => editorDirty.value || rowDirty.value || ttlDraft.value !== null || ttlWritePending.value || (
  isNew && (name.value !== '' || binaryKey.value || type.value !== 'string' || fieldsDirty.value)
))
watch(dirty, value => emit('dirty', value), { immediate: true, flush: 'sync' })

const scalar = kind => kind === 'string' || kind === 'ReJSON-RL'
const hasField = computed(() => ['hash', 'vectorset'].includes(type.value))
const hasIndex = computed(() => ['array', 'stream', 'TSDB-TYPE'].includes(type.value))
const supportsRows = computed(() => redisTypes.includes(type.value) && !scalar(type.value))
const freshness = computed(() => {
  if (loading.value) return 'loading'
  if (error.value) return snapshot.value && type.value !== 'none' ? 'stale' : 'error'
  if (type.value === 'none') return 'empty'
  return snapshot.value ? 'ready' : 'loading'
})
const lastSuccess = computed(() => snapshot.value?.updated)
const fresh = computed(() => freshness.value === 'ready')
const writable = computed(() => !props.connection.readOnly && (isNew || fresh.value))
const canWrite = computed(() => writable.value && !saving.value && !guarding.value)
const valueMatchesType = computed(() => scalarType.value === type.value)
const canSaveValue = computed(() => canWrite.value && Boolean(editor.value) && !editorRendering.value && (
  isNew || valueMatchesType.value && value.value !== null
))
const rowEditable = computed(() => writable.value && !rowDialog.value?.view && rowDialog.value?.kind === type.value)
const showStreamGroups = computed(() => type.value === 'stream' && streamView.value === 'groups')
const pollingStream = computed(() => fresh.value && props.visible && type.value === 'stream' && streamView.value === 'entries' && streamLive.value && !rowDialog.value)
const fieldTTLLabel = computed(() => props.connection.readOnly ? tr('查看字段 TTL', 'View field TTL') : tr('字段 TTL', 'Field TTL'))
let revision = 0
let disposed = false
let streamTimer
let refreshingStream = false

/** Run a Redis command in this tab's original database. */
function run(...args) {
  return command(props.tab.connection, props.tab.db, ...args)
}

/** Decode a field or key input according to its explicit hex toggle. */
function inputValue(text, hex) {
  if (!hex) return text
  const value = text.replace(/^0x/i, '').replace(/\s+/g, '')
  if (!/^(?:[a-f0-9]{2})*$/i.test(value)) throw new Error(tr('无效的十六进制内容', 'Invalid hexadecimal value'))
  return { hex: value }
}

/** Build a page in isolation, including empty pages encountered during filtered scans. */
async function readRows(kind, query, expected, cursor = null, existing = []) {
  const result = [...existing]
  const id = row => identity(row.field ?? row.index ?? row.value)
  const seen = new Set(existing.map(id))
  do {
    const page = await listedRows(run, kind, key, cursor, query.filter, query.range)
    if (expected !== revision) return null
    cursor = page.cursor
    for (const row of page.rows) {
      const rowId = id(row)
      if (seen.has(rowId)) continue
      seen.add(rowId)
      result.push(row)
    }
  } while (cursor !== null && !result.length)
  return { rows: result, next: cursor }
}

/** Publish metadata and content together after every required read succeeds. */
async function load() {
  if (disposed) return
  const expected = ++revision
  const query = { filter: filter.value, range: { ...range } }
  loading.value = true
  try {
    const [kind, seconds, bytes] = await Promise.all([
      run('TYPE', key),
      run('TTL', key),
      run('MEMORY', 'USAGE', key).catch(failure => {
        if (/\bNOPERM\b|unknown command/i.test(failure.message ?? String(failure))) return null
        throw failure
      }),
    ])
    if (expected !== revision) return
    const changed = () => new Error(tr('读取期间键已发生变化，请重试。', 'The key changed during refresh. Retry to load it again.'))
    if ((kind === 'none') !== (seconds === -2)) throw changed()
    const data = { type: kind, ttl: seconds, memory: bytes, value: null, count: null, rows: [], next: null, query }
    if (scalar(kind)) {
      data.value = await run(kind === 'string' ? 'GET' : 'JSON.GET', key)
      if (data.value == null) throw changed()
    } else if (redisTypes.includes(kind)) {
      data.count = await countRows(run, kind, key)
      if (expected !== revision) return
      Object.assign(data, await readRows(kind, query, expected))
    }
    if (expected !== revision) return
    if (!editorDirty.value) scalarType.value = scalar(kind) ? kind : ''
    snapshot.value = { ...data, updated: new Date() }
    if (ttlDraft.value === seconds) ttlDraft.value = null
    error.value = ''
  } catch (failure) {
    if (expected === revision) error.value = failure.message
  } finally {
    if (expected === revision) loading.value = false
  }
}

function refreshKey() {
  if (!loading.value && !saving.value && !guarding.value) void load()
}

/** Continue the last submitted query without exposing a partial response. */
async function loadRows() {
  if (!fresh.value || saving.value || guarding.value || next.value === null) return
  const expected = ++revision
  const previous = snapshot.value
  loading.value = true
  try {
    const page = await readRows(previous.type, previous.query, expected, previous.next, previous.rows)
    if (expected === revision) snapshot.value = { ...previous, ...page }
  } catch (failure) {
    if (expected === revision) error.value = failure.message
  } finally {
    if (expected === revision) loading.value = false
  }
}

watch(editorDirty, changed => {
  if (!isNew && !changed) scalarType.value = scalar(type.value) ? type.value : ''
})

/** Replace the live window with the latest entries in the last submitted range. */
async function refreshStream() {
  if (!pollingStream.value || loading.value || saving.value || refreshingStream) return
  const expected = revision
  refreshingStream = true
  try {
    const previous = snapshot.value
    const { filter, range } = previous.query
    const [page, length] = await Promise.all([
      listedRows(run, 'stream', key, null, filter, range),
      countRows(run, 'stream', key),
    ])
    if (expected !== revision || !pollingStream.value || saving.value) return
    snapshot.value = { ...previous, rows: page.rows, next: page.cursor, count: length, updated: new Date() }
  } catch (failure) {
    if (expected === revision && pollingStream.value && !saving.value) error.value = failure.message
  } finally {
    refreshingStream = false
  }
}

/** Poll only while the visible Stream tab is showing entries. */
watch([pollingStream, streamInterval], ([enabled, seconds]) => {
  clearInterval(streamTimer)
  if (!enabled) return
  refreshStream()
  streamTimer = setInterval(refreshStream, seconds * 1000)
})

/** Serialize writes and keep their errors beside the drafts they affect. */
async function write(operation, lock = false) {
  if (disposed || !canWrite.value) return
  saving.value = true
  lockInputs.value = lock
  writeError.value = ''
  try {
    await operation()
  } catch (failure) {
    if (!disposed) writeError.value = failure.message ?? String(failure)
  } finally {
    lockInputs.value = false
    saving.value = false
  }
}

function canContinueWrite() {
  return !disposed && writable.value
}

async function allowDiscard(hasDraft = dirty.value) {
  if (!hasDraft) return true
  if (guarding.value) return false
  guarding.value = true
  try {
    return await confirmDiscard([props.tab])
  } finally {
    guarding.value = false
  }
}

function discardDrafts() {
  editor.value?.discardDraft()
  ttlDraft.value = null
  rowDialog.value = null
  name.value = ''
  if (isNew) {
    newType.value = 'string'
    binaryKey.value = false
    Object.assign(draft, defaultFields)
  }
}

/** Create a key or save an edited string/JSON while preserving its existing expiration. */
function saveKey() {
  if (!canSaveValue.value) return
  return write(async () => {
    if (isNew) {
      const target = inputValue(name.value, binaryKey.value)
      const row = { ...draft, field: inputValue(draft.field, draft.fieldHex) }
      await createKey(run, type.value, target, row, editor.value.getValue(), ttl.value)
      if (disposed) return
      discardDrafts()
      notify(tr('已创建键', 'Key created'))
      emit('change', fromBytes(toBytes(target)))
    } else {
      const submission = editor.value.getSubmission()
      try {
        const data = submission.value
        const result = type.value === 'string'
          ? await run('SET', key, data, 'XX', 'KEEPTTL')
          : await run('JSON.SET', key, '$', data, 'XX')
        if (!result) throw new Error(tr('键已不存在，请刷新', 'Key no longer exists. Refresh first.'))
        if (disposed) return
        submission.accept()
      } finally {
        submission.finish()
      }
      await load()
      notify(tr('已保存', 'Saved'))
    }
  }, isNew)
}

/** Rename without overwriting an existing destination, including binary or empty names. */
function rename() {
  return write(async () => {
    const original = display(key)
    const proposed = await ask({ title: tr('重命名键', 'Rename key'), input: true, value: original })
    if (proposed === null || proposed === original) return
    const target = inputValue(proposed, binaryKey.value)
    if (identity(fromBytes(toBytes(target))) === identity(fromBytes(toBytes(key)))) return
    if (!await allowDiscard() || !canContinueWrite()) return
    const changed = await run('RENAMENX', key, target)
    if (!changed) throw new Error(tr('目标键已存在', 'Destination key already exists'))
    if (disposed) return
    discardDrafts()
    emit('change', fromBytes(toBytes(target)))
  }, true)
}

/** Update key expiration, asking for confirmation before an immediate expiration. */
function saveTTL() {
  const seconds = ttl.value
  const edit = ttlEdit
  return write(async () => {
    if (!Number.isSafeInteger(seconds) || seconds < -1) {
      throw new Error(tr('TTL 需要为 -1 或非负整数', 'TTL must be -1 or a non-negative integer'))
    }
    if (seconds === 0) {
      if (!await ask({ title: tr('立即过期', 'Expire immediately'), text: display(key), danger: true })) return
      if (!await allowDiscard(editorDirty.value || rowDirty.value) || !canContinueWrite()) return
    }
    ttlWritePending.value = ttlDraft.value !== null
    try {
      if (seconds === -1) await run('PERSIST', key)
      else if (!await run('EXPIRE', key, seconds)) throw new Error(tr('键已不存在，请刷新', 'Key no longer exists. Refresh first.'))
      if (disposed) return
      if (seconds === 0) {
        discardDrafts()
        ttlWritePending.value = false
        emit('change')
      } else {
        const newerTTL = ttl.value
        ttlDraft.value = ttlEdit === edit || newerTTL === seconds ? null : newerTTL
        ttlWritePending.value = false
        await load()
        notify(tr('TTL 已更新', 'TTL updated'))
      }
    } finally {
      ttlWritePending.value = false
    }
  }, seconds === 0)
}

/** Copy a Redis key name or duplicate the key into the selected destination database. */
function copyKey() {
  return write(async () => {
    const original = display(key)
    const target = await ask({ title: tr('复制到新键', 'Copy to a new key'), input: true, value: original + ':copy' })
    if (target === null || !canContinueWrite()) return
    const rawDb = await ask({ title: tr('目标数据库编号', 'Destination database index'), input: true, value: String(props.tab.db) })
    if (rawDb === null || !canContinueWrite()) return
    const db = Number(rawDb)
    if (!/^\d+$/.test(rawDb) || !Number.isSafeInteger(db)) throw new Error(tr('无效的数据库编号', 'Invalid database index'))
    const backup = await call('Export', props.tab.connection, props.tab.db, [asArg(key)])
    if (!backup.length) throw new Error(tr('源键已不存在', 'Source key no longer exists'))
    if (!canContinueWrite()) return
    const imported = await call('Import', props.tab.connection, db, [{ ...backup[0], key: asArg(target) }], false)
    if (imported.errors.length) throw new Error(imported.errors[0])
    if (disposed) return
    if (db === props.tab.db) emit('refresh-list')
    notify(tr('已复制键', 'Key copied'))
  })
}

/** Remove this key after displaying its exact name and database. */
function deleteKey() {
  return write(async () => {
    if (!await ask({ title: tr('删除键', 'Delete key'), text: 'DB ' + props.tab.db + ' · ' + display(key), danger: true })) return
    if (!await allowDiscard() || !canContinueWrite()) return
    await run('DEL', key)
    if (disposed) return
    discardDrafts()
    emit('change')
    notify(tr('已删除键', 'Key deleted'))
  }, true)
}

/** Download one exact DUMP backup, including the expiry metadata. */
async function exportKey() {
  try {
    const keys = await call('Export', props.tab.connection, props.tab.db, [asArg(key)])
    download('redis-key.json', JSON.stringify({ keys }))
  } catch (failure) {
    notify(failure, true)
  }
}

/** Open the type-specific add, edit, or read-only row dialog. */
async function showRow(row, view = false) {
  if (rowDialog.value || (!view && !canWrite.value)) return
  const kind = type.value
  const expected = revision
  try {
    let data = row?.value ?? ''
    let attributes = ''
    if (type.value === 'stream') {
      const fieldPairs = []
      for (let i = 0; i < (row?.value?.length || 0); i += 2) fieldPairs.push([row.value[i], row.value[i + 1]])
      data = pretty(row ? fieldPairs : { field: '' })
    }
    if (type.value === 'vectorset' && row) {
      const [embedding, info] = await Promise.all([run('VEMB', key, row.field), run('VGETATTR', key, row.field)])
      data = Array.isArray(embedding) ? embedding.join(' ') : display(embedding)
      attributes = display(info)
    }
    if (disposed || expected !== revision || rowDialog.value || (!view && !canWrite.value)) return
    const fields = {
      field: display(row?.field), fieldHex: typeof row?.field === 'object',
      score: String(row?.score ?? '0'), index: String(row?.index ?? ''),
      prepend: false, attributes,
    }
    rowEditorDirty.value = false
    rowEditorRendering.value = false
    writeError.value = ''
    rowDialog.value = {
      original: row, data: typeof data === 'number' ? String(data) : data, view, kind,
      ...fields, baseline: fields,
    }
  } catch (failure) {
    notify(failure, true)
  }
}

async function closeRow() {
  const form = rowDialog.value
  if (saving.value || !await allowDiscard(rowDirty.value) || rowDialog.value !== form) return
  rowDialog.value = null
  writeError.value = ''
}

/** Append an element or apply an atomic replacement, then refresh the current key. */
function saveRow() {
  if (!rowDialog.value || !rowEditable.value || rowEditorRendering.value || !rowEditor.value) return
  return write(async () => {
    const form = rowDialog.value
    const field = form.original && form.field === form.baseline.field && form.fieldHex === form.baseline.fieldHex
      ? form.original.field : inputValue(form.field, form.fieldHex)
    const row = { ...form, field }
    const data = rowEditor.value.getValue()
    if (form.original) await editRow(run, form.kind, key, row, form.original, data)
    else await run(...rowCommands(form.kind, key, row, data))
    if (disposed) return
    rowDialog.value = null
    await load()
    notify(tr('已保存', 'Saved'))
  }, true)
}

/** Delete a collection element and update the key list if it was the last element. */
function deleteRow(row) {
  return write(async () => {
    const text = display(row.field ?? row.index ?? row.value)
    if (!await ask({ title: tr('删除条目', 'Delete entry'), text, danger: true }) || !canContinueWrite()) return
    await removeRow(run, type.value, key, row)
    await load()
    if (disposed || type.value !== 'none') return
    if (dirty.value) emit('refresh-list')
    else emit('change')
  })
}

/** Inspect or change one hash-field TTL on servers that provide Redis 7.4 commands. */
async function fieldTTL(row) {
  if (!fresh.value || type.value !== 'hash' || saving.value || guarding.value) return
  const readTTL = async () => (await run('HTTL', key, 'FIELDS', 1, row.field))[0]
  if (props.connection.readOnly) {
    const expected = revision
    try {
      const current = await readTTL()
      if (expected !== revision) return
      extra.value = { title: tr('查看字段 TTL', 'View field TTL'), data: display(row.field) + '\nTTL (s) · ' + current }
    } catch (failure) {
      notify(failure, true)
    }
    return
  }
  return write(async () => {
    const current = await readTTL()
    if (!canContinueWrite()) return
    const proposed = await ask({ title: tr('字段 TTL（秒）', 'Field TTL (seconds)'), input: true, value: String(current), text: display(row.field) })
    if (proposed === null || !canContinueWrite()) return
    if (!/^(?:-1|[1-9]\d*)$/.test(proposed)) throw new Error(tr('请输入 -1 或正整数', 'Enter -1 or a positive number'))
    const operation = proposed === '-1' ? ['HPERSIST'] : ['HEXPIRE', proposed]
    const [result] = await run(operation[0], key, ...operation.slice(1), 'FIELDS', 1, row.field)
    if (result === -2) throw new Error(tr('字段已不存在，请刷新', 'Field no longer exists. Refresh first.'))
    notify(tr('字段 TTL 已更新', 'Field TTL updated'))
  })
}

/** Show metadata for the current Redis type. */
async function details(mode) {
  const args = {
    stream: ['XINFO', 'STREAM', key],
    'TSDB-TYPE': ['TS.INFO', key], vectorset: ['VINFO', key], array: ['ARINFO', key],
  }
  try {
    const data = await run(...args[mode])
    extra.value = { data: pretty(data) }
  } catch (failure) {
    notify(failure, true)
  }
}

/** Query Redis vector similarity using user-entered coordinates. */
async function similarity() {
  const text = await ask({ title: tr('查询向量相似度', 'Vector similarity query'), input: true, text: tr('用空格或逗号分隔坐标。', 'Separate coordinates with spaces or commas.') })
  if (!text?.trim()) return
  try {
    const values = text.trim().split(/[\s,]+/)
    if (values.some(value => !Number.isFinite(Number(value)))) throw new Error('Invalid vector values')
    const data = await run('VSIM', key, 'VALUES', values.length, ...values, 'WITHSCORES', 'COUNT', 30)
    extra.value = { data: pretty(data) }
  } catch (failure) {
    notify(failure, true)
  }
}

/** Guard changes that replace the type-specific inputs while keeping the common fields. */
async function changeType(event) {
  const target = event.target.value
  event.target.value = newType.value
  if (!canWrite.value || target === newType.value) return
  if (!await allowDiscard(editorDirty.value || fieldsDirty.value) || disposed || !canWrite.value) return
  editorDirty.value = false
  Object.assign(draft, defaultFields)
  newValue.value = target === 'stream' ? '{"field":""}' : target === 'ReJSON-RL' ? '{}' : ''
  newType.value = target
  writeError.value = ''
  event.target.value = target
}

async function discardIncompatibleValue() {
  if (!await allowDiscard(editorDirty.value) || disposed || valueMatchesType.value) return
  editor.value?.discardDraft()
}

/** Copy the selected key name to the host clipboard. */
async function copyName() {
  await Clipboard.SetText(display(key))
  notify(tr('已复制', 'Copied'))
}

onMounted(() => { if (!isNew) load() })
onUnmounted(() => {
  disposed = true
  revision++
  clearInterval(streamTimer)
})
</script>

<template>
  <div class="panel key-panel">
    <PanelHeader :icon="KeyRound">
      <template #eyebrow><span>{{ connection.name }}</span><ChevronRight :size="13" aria-hidden="true" /><span>DB {{ tab.db }}</span></template>
      <template #title><span class="key-title">{{ isNew ? tr('新建 Key', 'New key') : display(key) || '␀' }}</span></template>
      <template v-if="!isNew" #actions>
        <IconButton :label="tr('复制键名', 'Copy key name')" :icon="Copy" @click="copyName" />
        <IconButton :label="tr('导出键', 'Export key')" :icon="Download" @click="exportKey" />
        <IconButton :label="tr('刷新键', 'Refresh key')" :icon="RefreshCw" :loading="loading" :disabled="saving || guarding" @click="refreshKey" />
        <IconButton :label="tr('重命名键', 'Rename key')" :icon="Pencil" :disabled="!canWrite" @click="rename" />
        <IconButton :label="tr('删除键', 'Delete key')" :icon="Trash2" :disabled="!canWrite" danger @click="deleteKey" />
      </template>
    </PanelHeader>

    <StatusNotice v-if="connection.readOnly" tone="info" :title="tr('只读连接', 'Read-only connection')" />
    <StatusNotice v-if="dirty" tone="warning" :title="tr('未保存修改', 'Unsaved changes')" />
    <StatusNotice v-if="writeError && !rowDialog" tone="error" :text="writeError" />
    <form v-if="isNew" class="new-key-form" @submit.prevent="saveKey">
      <fieldset class="form-grid editor-fields" :disabled="!canWrite">
        <label>{{ tr('键名称', 'Key name') }}<input v-model="name" :placeholder="tr('输入键名称', 'Enter key name')" spellcheck="false" autofocus></label>
        <label>{{ tr('数据类型', 'Data type') }}<select :value="type" @change="changeType">
          <option v-for="kind in redisTypes" :key="kind" :value="kind">{{ typeName(kind) }}</option>
        </select></label>
        <label>TTL (s)<input v-model.number="ttl" type="number" required min="-1" :placeholder="tr('-1 为永久', '-1 for persistent')"></label>
        <label class="check-label"><input v-model="binaryKey" type="checkbox"> {{ tr('十六进制键名', 'Hexadecimal key name') }}</label>
        <label v-if="hasField">{{ tr('字段 / 元素名称', 'Field / element name') }}<input v-model="draft.field"></label>
        <label v-if="hasField" class="check-label"><input v-model="draft.fieldHex" type="checkbox"> {{ tr('十六进制字段', 'Hexadecimal field') }}</label>
        <label v-if="hasIndex">{{ tr('索引 / 时间戳', 'Index / timestamp') }}<input v-model="draft.index" :placeholder="type === 'array' ? '0' : '*'"></label>
        <label v-if="type === 'zset'">{{ tr('分数', 'Score') }}<input v-model="draft.score" required inputmode="decimal"></label>
        <label v-if="type === 'vectorset'">{{ tr('属性 JSON', 'Attribute JSON') }}<input v-model="draft.attributes" placeholder="{}"></label>
      </fieldset>
      <ValueEditor :key="type" ref="editor" :value="value" :read-only="!canWrite" :fixed="type === 'stream' || type === 'ReJSON-RL' ? 'JSON' : ''"
        compact @dirty="editorDirty = $event" @rendering="editorRendering = $event" />
      <div class="form-actions"><NButton size="small" type="primary" attr-type="submit" class="primary" :disabled="!canSaveValue"><Save :size="16" />{{ tr('创建键', 'Create key') }}</NButton></div>
    </form>

    <template v-else>
      <StatusNotice v-if="freshness === 'stale' || freshness === 'error'" :tone="freshness" :text="error" retry @retry="refreshKey" />
      <div v-if="snapshot" class="key-metadata">
        <time class="muted" :datetime="lastSuccess.toISOString()">{{ tr('最后成功读取', 'Last successful read') }} {{ lastSuccess.toLocaleTimeString() }}</time>
        <template v-if="type !== 'none'">
          <span class="type-pill" :data-type="type">{{ typeName(type) }}</span>
          <span v-if="memory !== null" class="muted">{{ memory.toLocaleString() }} B</span>
          <span v-if="count !== null" class="muted">{{ count.toLocaleString() }} {{ tr('条', 'entries') }}</span>
          <span class="spacer"></span>
          <label class="ttl-field"><Clock3 :size="15" aria-hidden="true" />TTL <input v-model.number="ttl" type="number" min="-1" aria-label="TTL" :readonly="!writable || lockInputs" @keydown.enter.prevent="saveTTL"></label>
          <NButton size="small" :disabled="!canWrite" @click="saveTTL">{{ tr('更新 TTL', 'Update TTL') }}</NButton>
          <NButton size="small" :disabled="!canWrite" @click="copyKey">{{ tr('复制到…', 'Copy to…') }}</NButton>
        </template>
      </div>
      <div v-if="freshness === 'loading' && !snapshot" class="empty-panel" role="status">{{ tr('正在读取键…', 'Reading key…') }}</div>
      <div v-if="type === 'none'" class="empty-panel">{{ tr('该键不存在或已过期。', 'This key is missing or expired.') }}</div>
      <div v-if="type || scalarType" class="key-main">
        <template v-if="scalarType">
          <div v-if="!valueMatchesType" class="retained-draft">
            <StatusNotice tone="warning" :text="tr('键的类型已变化或键已不存在，草稿已保留。', 'The key changed type or is missing. Your draft is still available.')" />
            <NButton size="small" :disabled="guarding" @click="discardIncompatibleValue">{{ tr('放弃值草稿', 'Discard value draft') }}</NButton>
          </div>
          <ValueEditor :key="scalarType" ref="editor" :value="valueMatchesType ? value : null" :source-version="lastSuccess" :read-only="!writable || !valueMatchesType || lockInputs"
            :fixed="scalarType === 'ReJSON-RL' ? 'JSON' : ''" :scope="scope" @dirty="editorDirty = $event" @rendering="editorRendering = $event" />
          <div v-if="!connection.readOnly && valueMatchesType" class="form-actions">
            <NButton size="small" type="primary" class="primary" :disabled="!canSaveValue" @click="saveKey"><Save :size="16" />{{ tr('保存值', 'Save value') }}</NButton>
          </div>
        </template>
        <div v-if="type === 'stream'" class="row-tools" role="group" :aria-label="tr('Stream 视图', 'Stream view')">
          <NButton size="small" :type="streamView === 'entries' ? 'primary' : 'default'" :aria-pressed="streamView === 'entries'" @click="streamView = 'entries'">{{ tr('消息条目', 'Stream entries') }}</NButton>
          <NButton size="small" :type="showStreamGroups ? 'primary' : 'default'" :aria-pressed="showStreamGroups" @click="streamView = 'groups'">{{ tr('消费组', 'Consumer groups') }}</NButton>
          <span class="spacer"></span>
          <template v-if="!showStreamGroups">
            <label class="soft-check">
              <NSwitch v-model:value="streamLive" size="small" :aria-label="tr('实时刷新', 'Live refresh')" />
              {{ tr('实时刷新', 'Live refresh') }}
            </label>
            <select v-if="streamLive" v-model.number="streamInterval" :aria-label="tr('刷新间隔', 'Refresh interval')">
              <option v-for="seconds in [1, 2, 5, 10]" :key="seconds" :value="seconds">{{ seconds }} {{ tr('秒', 's') }}</option>
            </select>
          </template>
        </div>
        <StreamGroups v-if="showStreamGroups" :stream-key="key" :run="run" :read-only="!canWrite" />
        <template v-else-if="supportsRows">
          <form class="row-tools" @submit.prevent="refreshKey">
            <label v-if="type !== 'TSDB-TYPE'" class="row-query-label">{{ tr('筛选条目', 'Filter entries') }}
              <span class="search-field"><Search :size="15" aria-hidden="true" /><input v-model="filter" spellcheck="false"></span>
            </label>
            <template v-if="type === 'stream' || type === 'TSDB-TYPE'">
              <label class="row-query-label">{{ tr('起始 ID / 时间戳', 'Start ID / timestamp') }}<input v-model="range.from" class="range"></label>
              <label class="row-query-label">{{ tr('结束 ID / 时间戳', 'End ID / timestamp') }}<input v-model="range.to" class="range"></label>
            </template>
            <NButton size="small" attr-type="submit" :disabled="loading || saving || guarding">{{ tr('查询', 'Search') }}</NButton>
            <span class="spacer"></span>
            <NButton size="small" v-if="type === 'stream' || type === 'TSDB-TYPE' || type === 'vectorset' || type === 'array'" @click="details(type)"><Info :size="15" />{{ tr('信息', 'Info') }}</NButton>
            <NButton size="small" v-if="type === 'vectorset'" @click="similarity">{{ tr('相似度', 'Similarity') }}</NButton>
            <NButton size="small" :disabled="!canWrite" @click="showRow()"><Plus :size="16" />{{ tr('添加条目', 'Add entry') }}</NButton>
          </form>
          <div class="table-wrap">
            <NTable size="small" :bordered="false" class="data-table">
              <thead><tr>
                <th v-if="hasField">{{ tr('字段 / 元素', 'Field / element') }}</th>
                <th v-if="hasIndex || type === 'list'">{{ tr('序号 / ID', 'Index / ID') }}</th>
                <th v-if="type !== 'vectorset'">{{ tr('值', 'Value') }}</th>
                <th v-if="type === 'zset'">{{ tr('分数', 'Score') }}</th><th class="row-ops">{{ tr('操作', 'Actions') }}</th>
              </tr></thead>
              <tbody>
                <tr v-for="row in rows" :key="identity(row.field ?? row.index ?? row.value)">
                  <td v-if="hasField" class="mono">{{ display(row.field) }}</td>
                  <td v-if="hasIndex || type === 'list'" class="mono">{{ row.index }}</td>
                  <td v-if="type !== 'vectorset'" class="table-value mono" :title="display(row.value)">{{ display(row.value) }}</td>
                  <td v-if="type === 'zset'" class="mono">{{ row.score }}</td>
                  <td class="row-ops">
                    <IconButton :label="tr('查看条目', 'View entry')" :icon="Info" @click="showRow(row, true)" />
                    <IconButton v-if="type !== 'stream'" :label="tr('编辑条目', 'Edit entry')" :icon="Pencil" :disabled="!canWrite" @click="showRow(row)" />
                    <IconButton v-if="type === 'hash'" :label="fieldTTLLabel" :icon="Clock3" :disabled="!fresh || saving || guarding" @click="fieldTTL(row)" />
                    <IconButton :label="tr('删除条目', 'Delete entry')" :icon="Trash2" :disabled="!canWrite" danger @click="deleteRow(row)" />
                  </td>
                </tr>
                <tr v-if="!rows.length"><td colspan="5" class="empty-cell">{{ loading ? tr('正在加载…', 'Loading…') : tr('没有符合条件的条目', 'No matching entries') }}</td></tr>
              </tbody>
            </NTable>
          </div>
          <div v-if="next !== null && !(type === 'stream' && streamLive)" class="form-actions"><NButton size="small" :disabled="!fresh || saving || guarding" @click="loadRows">{{ tr('加载更多', 'Load more') }}</NButton></div>
        </template>
        <p v-else-if="type && type !== 'none' && !scalar(type)" class="notice">{{ tr('可在命令行中操作此 Redis 类型。', 'Use the CLI to work with this Redis type.') }}</p>
      </div>
    </template>
  </div>

  <WorkspaceDialog v-if="rowDialog" :title-id="`${dialogId}-entry`" :busy="saving || guarding" @close="closeRow">
    <template #default="{ requestClose, closeDisabled, titleId }">
      <form class="modal wide-modal" aria-modal="true" :aria-labelledby="titleId" role="dialog" @submit.prevent="saveRow">
        <header class="modal-header">
          <h2 :id="titleId">{{ rowDialog.view ? tr('查看条目', 'View entry') : rowDialog.original ? tr('编辑条目', 'Edit entry') : tr('添加条目', 'Add entry') }}</h2>
          <IconButton :label="tr('关闭', 'Close')" :icon="X" :disabled="closeDisabled" @click="requestClose" />
        </header>
        <div class="modal-body">
          <StatusNotice v-if="rowDirty" tone="warning" :title="tr('未保存修改', 'Unsaved changes')" />
          <StatusNotice v-if="writeError" tone="error" :text="writeError" />
          <fieldset class="form-grid editor-fields" :disabled="!rowEditable || saving || guarding">
            <template v-if="['hash', 'vectorset'].includes(rowDialog.kind)">
              <label>{{ tr('字段 / 元素名称', 'Field / element name') }}<input v-model="rowDialog.field" :readonly="rowDialog.kind === 'vectorset' && Boolean(rowDialog.original)"></label>
              <label v-if="!rowDialog.view && !(rowDialog.kind === 'vectorset' && rowDialog.original)" class="check-label"><input v-model="rowDialog.fieldHex" type="checkbox"> {{ tr('十六进制字段', 'Hexadecimal field') }}</label>
            </template>
            <label v-if="['array', 'stream', 'TSDB-TYPE'].includes(rowDialog.kind)">{{ tr('索引 / 时间戳', 'Index / timestamp') }}<input v-model="rowDialog.index" :readonly="Boolean(rowDialog.original)" :placeholder="rowDialog.kind === 'array' ? '0' : '*'"></label>
            <label v-if="rowDialog.kind === 'zset'">{{ tr('分数', 'Score') }}<input v-model="rowDialog.score" required></label>
            <label v-if="rowDialog.kind === 'vectorset'">{{ tr('属性 JSON', 'Attribute JSON') }}<input v-model="rowDialog.attributes" placeholder="{}"></label>
            <label v-if="rowDialog.kind === 'list' && !rowDialog.original" class="check-label"><input v-model="rowDialog.prepend" type="checkbox"> {{ tr('添加到开头', 'Prepend') }}</label>
          </fieldset>
          <ValueEditor ref="rowEditor" :value="rowDialog.data" :read-only="!rowEditable || saving || guarding || rowDialog.kind === 'vectorset' && Boolean(rowDialog.original)"
            :fixed="rowDialog.kind === 'stream' ? 'JSON' : ''" :scope="scope" compact @dirty="rowEditorDirty = $event" @rendering="rowEditorRendering = $event" />
        </div>
        <footer class="modal-footer end"><NButton size="small" :disabled="closeDisabled" @click="requestClose">{{ tr('关闭', 'Close') }}</NButton>
          <NButton v-if="!rowDialog.view" size="small" type="primary" attr-type="submit" class="primary" :disabled="!canWrite || !rowEditable || rowEditorRendering">{{ tr('保存', 'Save') }}</NButton>
        </footer>
      </form>
    </template>
  </WorkspaceDialog>
  <WorkspaceDialog v-if="extra" :title-id="`${dialogId}-details`" :description-id="`${dialogId}-details-data`" @close="extra = null">
    <template #default="{ requestClose, titleId, descriptionId }">
      <section class="modal wide-modal" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId">
        <header class="modal-header"><h2 :id="titleId">{{ extra.title || tr('详细信息', 'Details') }}</h2>
          <IconButton :label="tr('关闭', 'Close')" :icon="X" @click="requestClose" /></header>
        <div class="modal-body"><pre :id="descriptionId">{{ extra.data }}</pre></div>
      </section>
    </template>
  </WorkspaceDialog>
</template>

<style scoped>
.key-title {
  overflow-wrap: anywhere;
}
.key-metadata time {
  flex-basis: 100%;
}
.row-query-label {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
}
.row-tools {
  align-items: end;
}
.editor-fields {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.editor-fields:empty {
  display: none;
}
.retained-draft {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
</style>
