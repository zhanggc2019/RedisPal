<script setup>
import { computed, inject, ref, watch } from 'vue'
import { Copy, Download, Play, Upload } from '@lucide/vue'
import { call, Clipboard } from './api.js'
import { download, toBytes, display, splitCommand } from './model.js'
import { encodeEdited, formats, guessFormat, renderFormat, writableFormats } from './formats.js'

const props = defineProps({ value: null, readOnly: Boolean, label: String, fixed: String, scope: String, compact: Boolean })
const tr = inject('tr')
const ask = inject('ask')
const notify = inject('notify')
const mode = ref(props.fixed || guessFormat(props.value))
const source = ref(props.value)
const text = ref('')
const baseline = ref('')
const failure = ref('')
const protoInput = ref(null)
const schema = ref(readLocal('ardm-proto-' + props.scope))
const showFull = ref(false)
const byteLength = computed(() => toBytes(source.value ?? '').byteLength)
const oversized = computed(() => byteLength.value > 2 * 1024 * 1024 && !showFull.value)
const writable = computed(() => !oversized.value && !props.readOnly && writableFormats.includes(mode.value))
let renderID = 0

/** Read optional formatter preferences from local storage. */
function readLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key))
  } catch {
    return null
  }
}

/** Render a format while dropping stale decoder results after a rapid mode change. */
async function refresh(custom) {
  const id = ++renderID
  failure.value = ''
  if (oversized.value) {
    text.value = ''
    baseline.value = ''
    return
  }
  try {
    const rendered = await renderFormat(mode.value, source.value, schema.value, custom, call)
    if (id === renderID) {
      text.value = rendered ?? ''
      baseline.value = text.value
    }
  } catch (error) {
    if (id === renderID) {
      text.value = ''
      failure.value = error.message
    }
  }
}

watch(() => props.value, (value, previous) => {
  source.value = value
  showFull.value = false
  if (previous == null && !props.fixed) mode.value = guessFormat(value)
  refresh()
}, { immediate: true })

/** Return the editor's current raw value for a Redis write. */
function getValue() {
  if (!writable.value || (text.value === baseline.value && source.value != null)) return source.value
  return encodeEdited(mode.value, text.value)
}

/** Preserve a draft when moving between editable formats. */
async function changeFormat(event) {
  const target = event.target.value
  let raw = source.value
  if (writable.value && text.value !== baseline.value) {
    try {
      raw = getValue()
    } catch (error) {
      event.target.value = mode.value
      notify(error, true)
      return
    }
  }
  source.value = raw
  mode.value = target
  await refresh()
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

defineExpose({ getValue })
</script>

<template>
  <div class="value-editor" :class="{ compact }">
    <div class="value-toolbar">
      <select v-if="!fixed" :value="mode" :aria-label="tr('值格式', 'Value format')" @change="changeFormat">
        <option v-for="format in formats" :key="format" :value="format">{{ format }}</option>
      </select>
      <span v-else class="badge">{{ fixed }}</span>
      <button v-if="mode === 'Protobuf'" type="button" @click="protoInput.click()"><Upload :size="14" /> .proto</button>
      <button v-if="mode === 'Protobuf' && schema" type="button" @click="clearSchema">{{ tr('移除 Schema', 'Clear schema') }}</button>
      <template v-if="mode === 'Custom'">
        <button type="button" @click="runCustom()"><Play :size="14" />{{ tr('运行', 'Run') }}</button>
        <button type="button" @click="runCustom(true)">{{ tr('配置', 'Configure') }}</button>
      </template>
      <span class="muted editor-bytes">{{ byteLength.toLocaleString() }} B</span>
      <span class="spacer"></span>
      <button class="flat icon" type="button" :title="tr('复制值', 'Copy value')" @click="copy"><Copy :size="15" /></button>
      <button class="flat icon" type="button" :title="tr('保存原始值到文件', 'Download raw value')" @click="download('redis-value.bin', toBytes(value ?? ''), 'application/octet-stream')"><Download :size="15" /></button>
      <input ref="protoInput" type="file" hidden multiple accept=".proto" @change="loadProto">
    </div>
    <p v-if="failure" class="notice error">{{ failure }}</p>
    <div v-if="oversized" class="empty-panel">
      <button type="button" @click="showFull = true; refresh()">{{ tr('加载完整值', 'Load full value') }}</button>
    </div>
    <textarea v-else v-model="text" :aria-label="label || tr('值', 'Value')" :readonly="!writable" spellcheck="false"></textarea>
  </div>
</template>
