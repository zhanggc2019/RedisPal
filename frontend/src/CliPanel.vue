<script setup>
import { computed, inject, nextTick, onUnmounted, ref } from 'vue'
import { Eraser, Play, Square, Terminal, Upload } from '@lucide/vue'
import { call, command } from './api.js'
import { allCMD } from './commands.js'
import { pretty } from './formats.js'
import { display, splitCommand } from './model.js'

const props = defineProps({ tab: Object, visible: Boolean, connection: Object })
const tr = inject('tr')
const ask = inject('ask')
const notify = inject('notify')
const text = ref('')
const db = ref(props.tab.db)
const entries = ref([])
const busy = ref(false)
const mode = ref('')
const output = ref(null)
const input = ref(null)
const fileInput = ref(null)
const historyKey = 'ardm-cli-history-' + props.connection.id
const history = ref(readHistory())
const position = ref(history.value.length)
const suggestions = computed(() => {
  const prefix = text.value.trim().toUpperCase()
  if (!prefix || prefix.includes(' ')) return []
  return Object.keys(allCMD).filter(name => name.startsWith(prefix)).sort().slice(0, 16)
})
const signatures = computed(() => {
  const name = text.value.trim().toUpperCase().split(/\s+/)[0]
  return allCMD[name] ? [allCMD[name]].flat().slice(0, 6).join('  ·  ') : ''
})
let poll
let closed = false

/** Restore recent commands while ignoring invalid storage. */
function readHistory() {
  try {
    return JSON.parse(localStorage.getItem(historyKey)) || []
  } catch {
    return []
  }
}

/** Append output without letting streaming commands grow the terminal indefinitely. */
function write(value, kind = '') {
  if (closed) return
  entries.value.push({ text: typeof value === 'string' ? value : pretty(value) ?? '(nil)', kind })
  if (entries.value.length > 1000) entries.value.splice(0, entries.value.length - 1000)
  nextTick(() => {
    if (output.value) output.value.scrollTop = output.value.scrollHeight
  })
}

/** Receive accumulated Pub/Sub or MONITOR messages from Go. */
async function pollFeed() {
  const startedMode = mode.value
  if (!startedMode) return
  try {
    const batch = await call('PollFeed', props.tab.id)
    if (mode.value !== startedMode) return
    for (const item of batch.messages) write((item.channel ? '[' + item.channel + '] ' : '') + display(item.value), 'event')
    if (batch.dropped) write(tr('已跳过消息', 'Messages dropped') + ': ' + batch.dropped, 'error')
    if (batch.error) {
      write(batch.error, 'error')
      await stop()
    }
  } catch (error) {
    write(error.message, 'error')
    await stop()
  } finally {
    if (mode.value === startedMode) poll = setTimeout(pollFeed, 450)
  }
}

/** Stop only this CLI tab's active Redis stream. */
async function stop() {
  clearTimeout(poll)
  mode.value = ''
  await call('StopFeed', props.tab.id)
}

/** Execute one CLI line, routing SELECT and streaming commands to dedicated state. */
async function execute(line, record = true) {
  const args = splitCommand(line)
  if (!args.length) return
  const kind = String(args[0]).toUpperCase()
  const sensitive = ['AUTH', 'HELLO', 'ACL'].includes(kind)
  write('DB ' + db.value + ' › ' + (sensitive ? kind + ' …' : line), 'request')
  if (record && !sensitive) {
    history.value = [...history.value.filter(old => old !== line), line].slice(-200)
    localStorage.setItem(historyKey, JSON.stringify(history.value))
    position.value = history.value.length
  }
  if (kind === 'CLEAR') {
    entries.value = []
  } else if (kind === 'SELECT') {
    const target = Number(args[1])
    if (args.length !== 2 || !/^\d+$/.test(args[1]) || !Number.isSafeInteger(target)) throw new Error('SELECT requires a logical database number')
    await command(props.connection.id, target, 'PING')
    db.value = target
    write('OK')
  } else if (['MONITOR', 'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE'].includes(kind)) {
    await stop()
    await call('StartFeed', props.connection.id, db.value, props.tab.id, kind, args.slice(1).map(display))
    if (closed) {
      await stop()
      return
    }
    mode.value = kind
    write(kind + ' · ' + tr('正在接收', 'Listening'), 'event')
    pollFeed()
  } else if (['STOP', 'UNSUBSCRIBE', 'PUNSUBSCRIBE', 'SUNSUBSCRIBE'].includes(kind)) {
    await stop()
    write('OK')
  } else {
    const value = await command(props.connection.id, db.value, ...args)
    write(value === null ? '(nil)' : value)
  }
}

/** Submit the interactive input and keep focus available for the next command. */
async function submit() {
  if (busy.value) return
  const line = text.value
  text.value = ''
  busy.value = true
  try {
    await execute(line)
  } catch (error) {
    write(error.message, 'error')
  } finally {
    busy.value = false
    nextTick(() => input.value?.focus())
  }
}

/** Navigate through stored CLI commands with the arrow keys, or complete with Tab. */
function keys(event) {
  if (event.key === 'Tab' && suggestions.value.length && suggestions.value[0] !== text.value) {
    event.preventDefault()
    text.value = suggestions.value[0] + ' '
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault()
    const delta = event.key === 'ArrowUp' ? -1 : 1
    position.value = Math.max(0, Math.min(history.value.length, position.value + delta))
    text.value = history.value[position.value] || ''
  } else if (mode.value && event.key.toLowerCase() === 'c' && event.ctrlKey && !getSelection()?.toString()) {
    event.preventDefault()
    stop().catch(error => write(error.message, 'error'))
  }
}

/** Execute a confirmed newline-delimited command file in order and show each outcome. */
async function runFile(event) {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file || busy.value) return
  try {
    const list = (await file.text()).split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
    if (!list.length || !await ask({ title: tr('执行命令文件', 'Run command file'), text: list.length + tr(' 条命令将按顺序执行。', ' commands will run in order.'), danger: true })) return
    busy.value = true
    for (const line of list) {
      if (closed) return
      try {
        await execute(line, false)
      } catch (error) {
        write(error.message, 'error')
      }
    }
  } catch (error) {
    notify(error, true)
  } finally {
    busy.value = false
  }
}

onUnmounted(() => {
  closed = true
  stop().catch(() => {})
})
</script>

<template>
  <div class="panel cli-panel">
    <header class="panel-heading">
      <div class="panel-title"><div class="eyebrow">{{ connection.name }} · DB {{ db }}</div><h1><Terminal :size="23" />Redis CLI</h1></div>
      <div class="heading-actions">
        <NButton size="small" v-if="mode" @click="stop()"><Square :size="14" />{{ tr('停止接收', 'Stop feed') }}</NButton>
        <NButton size="small" :disabled="busy" @click="fileInput.click()"><Upload :size="15" />{{ tr('执行文件', 'Run file') }}</NButton>
        <NButton size="small" @click="entries = []"><Eraser :size="16" />{{ tr('清屏', 'Clear') }}</NButton>
        <input ref="fileInput" type="file" hidden @change="runFile">
      </div>
    </header>
    <div class="terminal">
      <div ref="output" class="console-output" role="log" aria-live="polite">
        <pre v-if="!entries.length" class="console-empty">{{ tr('输入 Redis 命令。使用 ↑ / ↓ 浏览历史，Tab 自动补全。', 'Enter a Redis command. Use ↑ / ↓ for history and Tab to complete.') }}</pre>
        <pre v-for="(entry, i) in entries" :key="i" :class="entry.kind">{{ entry.text }}</pre>
      </div>
      <div v-if="signatures" class="console-help">{{ signatures }}</div>
      <form class="console-input" @submit.prevent="submit">
        <span>DB {{ db }} ›</span>
        <input ref="input" v-model="text" :list="'commands-' + tab.id" :aria-label="tr('Redis 命令', 'Redis command')" spellcheck="false" autocomplete="off" @keydown="keys">
        <datalist :id="'commands-' + tab.id"><option v-for="item in suggestions" :key="item" :value="item"></option></datalist>
        <NButton size="small" type="primary" attr-type="submit" class="primary" :disabled="busy || !text.trim()"><Play :size="14" />{{ tr('执行', 'Run') }}</NButton>
      </form>
    </div>
  </div>
</template>
