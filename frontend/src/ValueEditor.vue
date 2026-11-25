<script setup>
import { computed, inject, ref, shallowRef, watch } from 'vue'
import IconButton from './components/IconButton.vue'
import { Copy, Download, Play, Upload } from '@lucide/vue'
import { call, Clipboard } from './api.js'
import { download, toBytes, display, splitCommand } from './model.js'
import { encodeEdited, formats, guessFormat, renderFormat, writableFormats } from './formats.js'

const props = defineProps({ value: null, sourceVersion: Date, readOnly: Boolean, label: String, fixed: String, scope: String, compact: Boolean })
const emit = defineEmits(['dirty', 'rendering'])
const tr = inject('tr')
const ask = inject('ask')
const notify = inject('notify')
const mode = ref(props.fixed || guessFormat(props.value))
const source = shallowRef(props.value)
const draft = shallowRef(null)
const pendingSave = ref(false)
const rendered = ref('')
const baseline = ref('')
const failure = ref('')
const rendering = ref(false)
const protoInput = ref(null)
const schema = ref(readLocal('ardm-proto-' + props.scope))
const showFull = ref(false)
const byteLength = computed(() => toBytes(source.value ?? '').byteLength)
const oversized = computed(() => !draft.value && byteLength.value > 2 * 1024 * 1024 && !showFull.value)
const text = computed(() => draft.value?.mode === mode.value ? draft.value.text : rendered.value)
const writable = computed(() => !oversized.value && !rendering.value && !failure.value && !props.readOnly && writableFormats.includes(mode.value))
let renderID = 0
let displayedDraft = null
let lastEdit = null
watch(() => Boolean(draft.value) || pendingSave.value, dirty => emit('dirty', dirty), { immediate: true, flush: 'sync' })
watch(rendering, busy => emit('rendering', busy), { immediate: true, flush: 'sync' })

/** Read optional formatter preferences from local storage. */
function readLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key))
  } catch {
    return null
  }
}

/** Render the saved value and the draft independently, ignoring superseded decoders. */
async function refresh(custom) {
  const id = ++renderID
  const selected = mode.value
  const pending = draft.value
  const saved = source.value
  failure.value = ''
  rendering.value = !oversized.value
  if (!rendering.value) {
    rendered.value = ''
    baseline.value = ''
    displayedDraft = null
    return
  }
  const render = value => renderFormat(selected, value, schema.value, custom, call)
  try {
    const editable = writableFormats.includes(selected)
    const original = !pending || editable ? await render(saved) ?? '' : ''
    if (id !== renderID) return
    const working = pending?.mode === selected ? pending.text : pending ? await render(getValue()) ?? '' : original
    if (id !== renderID) return
    baseline.value = original
    rendered.value = working
    displayedDraft = pending
    if (pending && editable && working === original && saved != null && matchesSavedBytes(saved)) {
      displayedDraft = null
      draft.value = null
    }
  } catch (error) {
    if (id !== renderID) return
    rendered.value = ''
    failure.value = error.message
  } finally {
    if (id === renderID) rendering.value = false
  }
}

watch([() => props.value, () => props.fixed, () => props.sourceVersion], ([value, fixed], [previous, previousFixed]) => {
  if (value !== source.value) showFull.value = false
  source.value = value
  if (fixed !== previousFixed || (previous == null && !draft.value)) mode.value = fixed || guessFormat(value)
  void refresh()
}, { immediate: true })

function editText(next) {
  if (!writable.value) return
  lastEdit = { mode: mode.value, text: next }
  if (next === rendered.value && displayedDraft) {
    draft.value = displayedDraft
  } else if (next === baseline.value && source.value != null) {
    lastEdit.raw = source.value
    rendered.value = baseline.value
    displayedDraft = null
    draft.value = null
  } else {
    draft.value = lastEdit
  }
}

/** Keep the exact saved bytes or encode the draft in the format where it was edited. */
function getValue() {
  const pending = draft.value
  return pending ? pending.raw ?? encodeEdited(pending.mode, pending.text) : source.value
}

function matchesSavedBytes(saved) {
  try {
    const draftBytes = toBytes(getValue())
    const savedBytes = toBytes(saved)
    return draftBytes.length === savedBytes.length && draftBytes.every((byte, index) => byte === savedBytes[index])
  } catch {
    return false
  }
}

/** Rebase after a write while retaining edits made after the request started. */
function getSubmission() {
  const submitted = draft.value
  const edit = lastEdit
  const value = getValue()
  pendingSave.value = Boolean(submitted)
  return {
    value,
    accept() {
      source.value = value
      if (lastEdit === edit || draft.value === submitted) draft.value = null
      else if (!draft.value) draft.value = lastEdit
      void refresh()
    },
    finish() {
      pendingSave.value = false
    },
  }
}

function discardDraft() {
  draft.value = null
  void refresh()
}

/** Leave invalid input available for correction instead of dropping it on format change. */
function changeFormat(event) {
  const target = event.target.value
  try {
    if (draft.value?.mode === mode.value) getValue()
  } catch (error) {
    event.target.value = mode.value
    notify(error, true)
    return
  }
  mode.value = target
  void refresh()
}

/** Copy a view without executing any content in the decoded value. */
async function copy() {
  try {
    await Clipboard.SetText(text.value)
    notify(tr('已复制', 'Copied'))
  } catch (error) {
    notify(error, true)
  }
}

/** Forget a stored protobuf schema and return to raw inference. */
function clearSchema() {
  schema.value = null
  if (props.scope) localStorage.removeItem('ardm-proto-' + props.scope)
  refresh()
}

/** Select one or more .proto files and persist their schema for this Redis key. */
async function loadProto(event) {
  const files = [...event.target.files]
  event.target.value = ''
  if (!files.length) return
  const type = await ask({ title: tr('Protobuf 消息全名', 'Protobuf message name'), input: true, value: schema.value?.type || '' })
  if (!type?.trim()) return
  try {
    schema.value = { type: type.trim(), sources: await Promise.all(files.map(file => file.text())) }
    if (props.scope) localStorage.setItem('ardm-proto-' + props.scope, JSON.stringify(schema.value))
    await refresh()
  } catch (error) {
    notify(error, true)
  }
}

/** Configure and explicitly run a local formatter with the Redis value on standard input. */
async function runCustom(configure = false) {
  let custom = readLocal('ardm-custom-formatter')
  try {
    if (!custom?.executable || configure) {
      const executable = await ask({ title: tr('格式化程序路径', 'Formatter executable'), input: true, value: custom?.executable || '' })
      if (!executable?.trim()) return
      const rawArgs = await ask({ title: tr('命令参数', 'Arguments'), text: tr('值通过标准输入传递。参数也可使用 {VALUE} 或 {HEX}。', 'The value is sent to standard input. Arguments can also use {VALUE} or {HEX}.'), input: true, value: custom?.rawArgs || '' })
      if (rawArgs === null) return
      custom = { executable: executable.trim(), rawArgs, args: splitCommand(rawArgs).map(display) }
      localStorage.setItem('ardm-custom-formatter', JSON.stringify(custom))
    }
    await refresh(custom)
  } catch (error) {
    notify(error, true)
  }
}

defineExpose({ getValue, getSubmission, discardDraft })
</script>

<template>
  <div class="value-editor" :class="{ compact }">
    <div class="value-toolbar">
      <select v-if="!fixed" :value="mode" :aria-label="tr('值格式', 'Value format')" @change="changeFormat">
        <option v-for="format in formats" :key="format" :value="format">{{ format }}</option>
      </select>
      <NTag v-else size="small" type="primary" :bordered="false">{{ fixed }}</NTag>
      <NButton size="small" v-if="mode === 'Protobuf'" @click="protoInput.click()"><Upload :size="14" /> .proto</NButton>
      <NButton size="small" v-if="mode === 'Protobuf' && schema" @click="clearSchema">{{ tr('移除 Schema', 'Clear schema') }}</NButton>
      <template v-if="mode === 'Custom'">
        <NButton size="small" @click="runCustom()"><Play :size="14" />{{ tr('运行', 'Run') }}</NButton>
        <NButton size="small" @click="runCustom(true)">{{ tr('配置', 'Configure') }}</NButton>
      </template>
      <span class="muted editor-bytes">{{ byteLength.toLocaleString() }} B</span>
      <span class="spacer"></span>
      <IconButton :label="tr('复制值', 'Copy value')" :icon="Copy" :disabled="rendering" @click="copy" />
      <IconButton :label="tr('保存原始值到文件', 'Download raw value')" :icon="Download" @click="download('redis-value.bin', toBytes(source ?? ''), 'application/octet-stream')" />
      <input ref="protoInput" type="file" hidden multiple accept=".proto" @change="loadProto">
    </div>
    <p v-if="failure" class="notice error" role="alert">{{ failure }}</p>
    <div v-if="oversized" class="empty-panel">
      <NButton size="small" @click="showFull = true; refresh()">{{ tr('加载完整值', 'Load full value') }}</NButton>
    </div>
    <NInput v-else :value="text" class="editor-input" type="textarea" :rows="compact ? 7 : 13"
      :readonly="!writable" :input-props="{ 'aria-label': label || tr('值', 'Value'), spellcheck: false }" @update:value="editText" />
  </div>
</template>

<style scoped>
.value-toolbar {
  flex-wrap: wrap;
}
</style>
