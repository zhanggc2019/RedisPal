<script setup>
import { computed, inject, onMounted, reactive, ref } from 'vue'
import { ChevronRight, Clock3, Copy, Download, Info, KeyRound, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from '@lucide/vue'
import { call, Clipboard, command } from './api.js'
import { asArg, display, download, fromBytes, identity, toBytes } from './model.js'
import { pretty } from './formats.js'
import { countRows, createKey, editRow, listedRows, redisTypes, removeRow, rowCommands, typeName } from './keydata.js'
import ValueEditor from './ValueEditor.vue'

const props = defineProps({ tab: Object, connection: Object })
const emit = defineEmits(['change', 'refresh-list', 'open-key'])
const tr = inject('tr')
const ask = inject('ask')
const notify = inject('notify')
const isNew = props.tab.kind === 'new'
const key = props.tab.key
const type = ref(isNew ? 'string' : '')
const value = ref(null)
const rows = ref([])
const count = ref(null)
const next = ref(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const ttl = ref(-1)
const memory = ref(null)
const name = ref(isNew ? '' : display(key))
const binaryKey = ref(typeof key === 'object')
const filter = ref('')
const range = reactive({ from: '', to: '' })
const editor = ref(null)
const rowEditor = ref(null)
const rowDialog = ref(null)
const extra = ref(null)
const draft = reactive({ field: '', fieldHex: false, score: '0', index: '', prepend: false, attributes: '' })
const scope = props.tab.connection + ':' + props.tab.db + ':' + (key === undefined ? props.tab.id : identity(key))
const hasField = computed(() => ['hash', 'vectorset'].includes(type.value))
const hasIndex = computed(() => ['array', 'stream', 'TSDB-TYPE'].includes(type.value))
const isScalar = computed(() => ['string', 'ReJSON-RL'].includes(type.value))
const supportsRows = computed(() => redisTypes.includes(type.value) && !isScalar.value)
let revision = 0

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

/** Load a key's type, TTL, footprint, and first page of its data. */
async function load() {
  const expected = ++revision
  loading.value = true
  error.value = ''
  rows.value = []
  next.value = null
  try {
    const [kind, seconds, bytes] = await Promise.all([run('TYPE', key), run('TTL', key), run('MEMORY', 'USAGE', key).catch(() => null)])
    if (expected !== revision) return
    type.value = kind
    ttl.value = seconds
    memory.value = bytes
    if (kind === 'none') return
    if (kind === 'string' || kind === 'ReJSON-RL') {
      const data = await run(kind === 'string' ? 'GET' : 'JSON.GET', key)
      if (expected === revision) value.value = data
    } else if (supportsRows.value) {
      count.value = await countRows(run, kind, key)
      await loadRows(true, expected)
    }
  } catch (failure) {
    if (expected === revision) error.value = failure.message
  } finally {
    if (expected === revision) loading.value = false
  }
}

/** Refresh or continue a collection page, including empty pages produced by filtered scans. */
async function loadRows(reset = false, expected = ++revision) {
  if (reset) {
    rows.value = []
    next.value = null
  }
  loading.value = true
  error.value = ''
  const seen = new Set(rows.value.map(row => identity(row.field ?? row.index ?? row.value)))
  try {
    do {
      const page = await listedRows(run, type.value, key, next.value, filter.value, range)
      if (expected !== revision) return
      next.value = page.cursor
      for (const row of page.rows) {
        const id = identity(row.field ?? row.index ?? row.value)
        if (seen.has(id)) continue
        seen.add(id)
        rows.value.push(row)
      }
    } while (next.value !== null && !rows.value.length)
  } catch (failure) {
    if (expected === revision) error.value = failure.message
  } finally {
    if (expected === revision) loading.value = false
  }
}

/** Create a key or save an edited string/JSON while preserving its existing expiration. */
async function saveKey() {
  if (saving.value) return
  saving.value = true
  try {
    const data = editor.value.getValue()
    if (isNew) {
      const target = inputValue(name.value, binaryKey.value)
      const row = { ...draft, field: inputValue(draft.field, draft.fieldHex) }
      await createKey(run, type.value, target, row, data, ttl.value)
      notify(tr('已创建键', 'Key created'))
      emit('change', fromBytes(toBytes(target)))
    } else {
      if (type.value === 'string') {
        const result = await run('SET', key, data, 'XX', 'KEEPTTL')
        if (!result) throw new Error(tr('键已不存在，请刷新', 'Key no longer exists. Refresh first.'))
      } else {
        const result = await run('JSON.SET', key, '$', data, 'XX')
        if (!result) throw new Error(tr('键已不存在，请刷新', 'Key no longer exists. Refresh first.'))
      }
      await load()
      notify(tr('已保存', 'Saved'))
    }
  } catch (failure) {
    notify(failure, true)
  } finally {
    saving.value = false
  }
}

/** Rename without overwriting an existing destination, including binary or empty names. */
async function rename() {
  const proposed = await ask({ title: tr('重命名键', 'Rename key'), input: true, value: display(key) })
  if (proposed === null || proposed === display(key)) return
  try {
    const target = inputValue(proposed, binaryKey.value)
    const changed = await run('RENAMENX', key, target)
    if (!changed) throw new Error(tr('目标键已存在', 'Destination key already exists'))
    emit('change', fromBytes(toBytes(target)))
  } catch (failure) {
    notify(failure, true)
  }
}

/** Update key expiration, asking for confirmation before an immediate expiration. */
async function saveTTL() {
  if (!Number.isSafeInteger(ttl.value) || ttl.value < -1) return notify(tr('TTL 需要为 -1 或非负整数', 'TTL must be -1 or a non-negative integer'), true)
  if (ttl.value === 0 && !await ask({ title: tr('立即过期', 'Expire immediately'), text: display(key), danger: true })) return
  try {
    if (ttl.value === -1) await run('PERSIST', key)
    else await run('EXPIRE', key, ttl.value)
    if (ttl.value === 0) emit('change')
    else {
      await load()
      notify(tr('TTL 已更新', 'TTL updated'))
    }
  } catch (failure) {
    notify(failure, true)
  }
}

/** Copy a Redis key name or duplicate the key into the selected destination database. */
async function copyKey() {
  const original = display(key)
  const target = await ask({ title: tr('复制到新键', 'Copy to a new key'), input: true, value: original + ':copy' })
  if (target === null) return
  const rawDb = await ask({ title: tr('目标数据库编号', 'Destination database index'), input: true, value: String(props.tab.db) })
  if (rawDb === null) return
  const db = Number(rawDb)
  if (!/^\d+$/.test(rawDb) || !Number.isSafeInteger(db)) return notify(tr('无效的数据库编号', 'Invalid database index'), true)
  try {
    const backup = await call('Export', props.tab.connection, props.tab.db, [asArg(key)])
    if (!backup.length) throw new Error(tr('源键已不存在', 'Source key no longer exists'))
    const imported = await call('Import', props.tab.connection, db, [{ ...backup[0], key: asArg(target) }], false)
    if (imported.errors.length) throw new Error(imported.errors[0])
    if (db === props.tab.db) emit('refresh-list')
    notify(tr('已复制键', 'Key copied'))
  } catch (failure) {
    notify(failure, true)
  }
}

/** Remove this key after displaying its exact name and database. */
async function deleteKey() {
  if (!await ask({ title: tr('删除键', 'Delete key'), text: 'DB ' + props.tab.db + ' · ' + display(key), danger: true })) return
  try {
    await run('DEL', key)
    emit('change')
    notify(tr('已删除键', 'Key deleted'))
  } catch (failure) {
    notify(failure, true)
  }
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
    rowDialog.value = {
      original: row, data: typeof data === 'number' ? String(data) : data, view,
      field: display(row?.field), fieldHex: typeof row?.field === 'object',
      score: String(row?.score ?? '0'), index: String(row?.index ?? ''),
      prepend: false, attributes,
    }
  } catch (failure) {
    notify(failure, true)
  }
}

/** Append an element or apply an atomic replacement, then refresh the current key. */
async function saveRow() {
  if (saving.value) return
  saving.value = true
  try {
    const form = rowDialog.value
    const row = { ...form, field: inputValue(form.field, form.fieldHex) }
    const data = rowEditor.value.getValue()
    if (form.original) await editRow(run, type.value, key, row, form.original, data)
    else await run(...rowCommands(type.value, key, row, data))
    rowDialog.value = null
    await load()
    notify(tr('已保存', 'Saved'))
  } catch (failure) {
    notify(failure, true)
  } finally {
    saving.value = false
  }
}

/** Delete a collection element and update the key list if it was the last element. */
async function deleteRow(row) {
  const text = display(row.field ?? row.index ?? row.value)
  if (!await ask({ title: tr('删除条目', 'Delete entry'), text, danger: true })) return
  try {
    await removeRow(run, type.value, key, row)
    await load()
    if (type.value === 'none') emit('change')
  } catch (failure) {
    notify(failure, true)
  }
}

/** Inspect or change one hash-field TTL on servers that provide Redis 7.4 commands. */
async function fieldTTL(row) {
  try {
    const [current] = await run('HTTL', key, 'FIELDS', 1, row.field)
    if (props.connection.readOnly) return notify('TTL · ' + current)
    const proposed = await ask({ title: tr('字段 TTL（秒）', 'Field TTL (seconds)'), input: true, value: String(current), text: display(row.field) })
    if (proposed === null) return
    if (!/^(?:-1|[1-9]\d*)$/.test(proposed)) throw new Error(tr('请输入 -1 或正整数', 'Enter -1 or a positive number'))
    const operation = proposed === '-1' ? ['HPERSIST'] : ['HEXPIRE', proposed]
    await run(operation[0], key, ...operation.slice(1), 'FIELDS', 1, row.field)
    notify(tr('字段 TTL 已更新', 'Field TTL updated'))
  } catch (failure) {
    notify(failure, true)
  }
}

/** Show module metadata or stream group/consumer information. */
async function details(mode, group = '') {
  const args = {
    stream: ['XINFO', 'STREAM', key], groups: ['XINFO', 'GROUPS', key], consumers: ['XINFO', 'CONSUMERS', key, group],
    'TSDB-TYPE': ['TS.INFO', key], vectorset: ['VINFO', key], array: ['ARINFO', key],
  }
  try {
    const data = await run(...args[mode])
    const groups = mode === 'groups' ? data.map(entries => entries[entries.indexOf('name') + 1]) : []
    extra.value = { mode, data: pretty(data), groups }
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
    extra.value = { mode: 'VSIM', data: pretty(data), groups: [] }
  } catch (failure) {
    notify(failure, true)
  }
}

/** Reset type-specific input when switching a new-key form. */
function changeType() {
  Object.assign(draft, { field: '', fieldHex: false, score: '0', index: '', prepend: false, attributes: '' })
  value.value = type.value === 'stream' ? '{"field":""}' : type.value === 'ReJSON-RL' ? '{}' : ''
}

/** Copy the selected key name to the host clipboard. */
async function copyName() {
  await Clipboard.SetText(display(key))
  notify(tr('已复制', 'Copied'))
}

onMounted(() => { if (!isNew) load() })
</script>

<template>
  <div class="panel key-panel">
    <header class="panel-heading">
      <div class="panel-title">
        <div class="eyebrow"><span>{{ connection.name }}</span><ChevronRight :size="13" /><span>DB {{ tab.db }}</span></div>
        <h1><KeyRound :size="22" />{{ isNew ? tr('新建 Key', 'New key') : display(key) || '␀' }}</h1>
      </div>
      <div v-if="!isNew" class="heading-actions">
        <button class="icon" :title="tr('复制键名', 'Copy key name')" @click="copyName"><Copy :size="16" /></button>
        <button class="icon" :title="tr('导出键', 'Export key')" @click="exportKey"><Download :size="16" /></button>
        <button class="icon" :title="tr('刷新键', 'Refresh key')" @click="load"><RefreshCw :size="16" :class="{ spin: loading }" /></button>
        <button class="icon danger" :title="tr('删除键', 'Delete key')" :aria-label="tr('删除键', 'Delete key')" :disabled="connection.readOnly || type === 'none'" @click="deleteKey"><Trash2 :size="16" /></button>
      </div>
    </header>

    <form v-if="isNew" class="new-key-form" @submit.prevent="saveKey">
      <div class="form-grid">
        <label>{{ tr('键名称', 'Key name') }}<input v-model="name" :placeholder="tr('输入键名称', 'Enter key name')" spellcheck="false" autofocus></label>
        <label>{{ tr('数据类型', 'Data type') }}<select v-model="type" @change="changeType">
          <option v-for="kind in redisTypes" :key="kind" :value="kind">{{ typeName(kind) }}</option>
        </select></label>
        <label>TTL (s)<input v-model.number="ttl" type="number" required min="-1" :placeholder="tr('-1 为永久', '-1 for persistent')"></label>
        <label class="check-label"><input v-model="binaryKey" type="checkbox"> {{ tr('十六进制键名', 'Hexadecimal key name') }}</label>
        <label v-if="hasField">{{ tr('字段 / 元素名称', 'Field / element name') }}<input v-model="draft.field"></label>
        <label v-if="hasField" class="check-label"><input v-model="draft.fieldHex" type="checkbox"> {{ tr('十六进制字段', 'Hexadecimal field') }}</label>
        <label v-if="hasIndex">{{ tr('索引 / 时间戳', 'Index / timestamp') }}<input v-model="draft.index" :placeholder="type === 'array' ? '0' : '*'"></label>
        <label v-if="type === 'zset'">{{ tr('分数', 'Score') }}<input v-model="draft.score" required inputmode="decimal"></label>
        <label v-if="type === 'vectorset'">{{ tr('属性 JSON', 'Attribute JSON') }}<input v-model="draft.attributes" placeholder="{}"></label>
      </div>
      <ValueEditor :key="type" ref="editor" :value="value ?? ''" :fixed="type === 'stream' || type === 'ReJSON-RL' ? 'JSON' : ''" compact />
      <div class="form-actions"><button class="primary" type="submit" :disabled="saving"><Save :size="16" />{{ tr('创建键', 'Create key') }}</button></div>
    </form>

    <template v-else>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <div v-if="type === 'none'" class="empty-panel">{{ tr('该键不存在或已过期。', 'This key is missing or expired.') }}</div>
      <div v-else-if="type" class="key-main">
        <div class="key-metadata">
          <span class="type-pill" :data-type="type">{{ typeName(type) }}</span>
          <span class="muted" v-if="memory !== null">{{ memory.toLocaleString() }} B</span>
          <span class="muted" v-if="count !== null">{{ count.toLocaleString() }} {{ tr('条', 'entries') }}</span>
          <span class="spacer"></span>
          <label class="ttl-field"><Clock3 :size="15" />TTL <input v-model.number="ttl" type="number" min="-1" aria-label="TTL" :readonly="connection.readOnly" @keydown.enter="!connection.readOnly && saveTTL()"></label>
          <button :disabled="connection.readOnly" @click="saveTTL">{{ tr('更新 TTL', 'Update TTL') }}</button>
          <button :disabled="connection.readOnly" @click="rename"><Pencil :size="14" />{{ tr('重命名', 'Rename') }}</button>
          <button :disabled="connection.readOnly" @click="copyKey">{{ tr('复制到…', 'Copy to…') }}</button>
        </div>
        <template v-if="isScalar">
          <ValueEditor ref="editor" :value="value" :read-only="connection.readOnly" :fixed="type === 'ReJSON-RL' ? 'JSON' : ''" :scope="scope" />
          <div v-if="!connection.readOnly" class="form-actions">
            <button class="primary" :disabled="saving || loading || value === null" @click="saveKey"><Save :size="16" />{{ tr('保存值', 'Save value') }}</button>
          </div>
        </template>
        <template v-else-if="supportsRows">
          <form class="row-tools" @submit.prevent="loadRows(true)">
            <div v-if="type !== 'TSDB-TYPE'" class="search-field"><Search :size="15" /><input v-model="filter" :placeholder="tr('搜索条目', 'Filter entries')" spellcheck="false"></div>
            <template v-if="type === 'stream' || type === 'TSDB-TYPE'">
              <input v-model="range.from" class="range" :placeholder="tr('起始 ID / 时间戳', 'Start ID / timestamp')">
              <input v-model="range.to" class="range" :placeholder="tr('结束 ID / 时间戳', 'End ID / timestamp')">
            </template>
            <button type="submit" :disabled="loading">{{ tr('查询', 'Search') }}</button>
            <span class="spacer"></span>
            <button v-if="type === 'stream' || type === 'TSDB-TYPE' || type === 'vectorset' || type === 'array'" type="button" @click="details(type)"><Info :size="15" />{{ tr('信息', 'Info') }}</button>
            <button v-if="type === 'stream'" type="button" @click="details('groups')">{{ tr('消费组', 'Groups') }}</button>
            <button v-if="type === 'vectorset'" type="button" @click="similarity">{{ tr('相似度', 'Similarity') }}</button>
            <button type="button" class="primary" :disabled="connection.readOnly" @click="showRow()"><Plus :size="16" />{{ tr('添加条目', 'Add entry') }}</button>
          </form>
          <div class="table-wrap">
            <table class="data-table">
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
                    <button class="flat icon" :title="tr('查看条目', 'View entry')" @click="showRow(row, true)"><Info :size="15" /></button>
                    <button v-if="type !== 'stream'" class="flat icon" :title="tr('编辑条目', 'Edit entry')" :disabled="connection.readOnly" @click="showRow(row)"><Pencil :size="15" /></button>
                    <button v-if="type === 'hash'" class="flat icon" :title="tr('字段 TTL', 'Field TTL')" @click="fieldTTL(row)"><Clock3 :size="15" /></button>
                    <button class="flat icon danger" :title="tr('删除条目', 'Delete entry')" :disabled="connection.readOnly" @click="deleteRow(row)"><Trash2 :size="15" /></button>
                  </td>
                </tr>
                <tr v-if="!rows.length"><td colspan="5" class="empty-cell">{{ loading ? tr('正在加载…', 'Loading…') : tr('没有符合条件的条目', 'No matching entries') }}</td></tr>
              </tbody>
            </table>
          </div>
          <div v-if="next !== null" class="form-actions"><button :disabled="loading" @click="loadRows()">{{ tr('加载更多', 'Load more') }}</button></div>
        </template>
        <p v-else class="notice">{{ tr('可在命令行中操作此 Redis 类型。', 'Use the CLI to work with this Redis type.') }}</p>
      </div>
      <div v-else-if="loading" class="empty-panel">{{ tr('正在读取键…', 'Reading key…') }}</div>
    </template>
  </div>

  <Teleport to="#overlay-host">
    <div v-if="rowDialog" class="modal-backdrop" @click.self="rowDialog = null" @keydown.esc="rowDialog = null">
      <form class="modal wide-modal" aria-modal="true" role="dialog" @submit.prevent="saveRow">
        <header class="modal-header">
          <h2>{{ rowDialog.view ? tr('查看条目', 'View entry') : rowDialog.original ? tr('编辑条目', 'Edit entry') : tr('添加条目', 'Add entry') }}</h2>
          <button class="flat icon" type="button" @click="rowDialog = null"><X :size="19" /></button>
        </header>
        <div class="modal-body">
          <div v-if="hasField || hasIndex || type === 'zset' || type === 'list' && !rowDialog.original" class="form-grid">
            <label v-if="hasField">{{ tr('字段 / 元素名称', 'Field / element name') }}<input v-model="rowDialog.field" :readonly="rowDialog.view || (type === 'vectorset' && Boolean(rowDialog.original))"></label>
            <label v-if="hasField && !rowDialog.view" class="check-label"><input v-model="rowDialog.fieldHex" type="checkbox"> {{ tr('十六进制字段', 'Hexadecimal field') }}</label>
            <label v-if="hasIndex">{{ tr('索引 / 时间戳', 'Index / timestamp') }}<input v-model="rowDialog.index" :readonly="Boolean(rowDialog.original)" :placeholder="type === 'array' ? '0' : '*'"></label>
            <label v-if="type === 'zset'">{{ tr('分数', 'Score') }}<input v-model="rowDialog.score" :readonly="rowDialog.view" required></label>
            <label v-if="type === 'vectorset'">{{ tr('属性 JSON', 'Attribute JSON') }}<input v-model="rowDialog.attributes" :readonly="rowDialog.view" placeholder="{}"></label>
            <label v-if="type === 'list' && !rowDialog.original" class="check-label"><input v-model="rowDialog.prepend" type="checkbox"> {{ tr('添加到开头', 'Prepend') }}</label>
          </div>
          <ValueEditor ref="rowEditor" :value="rowDialog.data" :read-only="rowDialog.view || type === 'vectorset' && Boolean(rowDialog.original)"
            :fixed="type === 'stream' ? 'JSON' : ''" :scope="scope" compact />
        </div>
        <footer class="modal-footer end"><button type="button" @click="rowDialog = null">{{ tr('关闭', 'Close') }}</button>
          <button v-if="!rowDialog.view" class="primary" :disabled="saving" type="submit">{{ tr('保存', 'Save') }}</button>
        </footer>
      </form>
    </div>
    <div v-if="extra" class="modal-backdrop" @click.self="extra = null" @keydown.esc="extra = null">
      <section class="modal wide-modal" role="dialog" aria-modal="true">
        <header class="modal-header"><h2>{{ extra.mode === 'groups' ? tr('消费组', 'Groups') : tr('详细信息', 'Details') }}</h2>
          <button class="flat icon" @click="extra = null"><X :size="19" /></button></header>
        <div class="modal-body"><div v-if="extra.groups.length" class="row-tools">
          <button v-for="group in extra.groups" :key="display(group)" @click="details('consumers', group)">{{ tr('消费者', 'Consumers') }} · {{ display(group) }}</button>
        </div><pre>{{ extra.data }}</pre></div>
      </section>
    </div>
  </Teleport>
</template>
