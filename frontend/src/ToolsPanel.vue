<script setup>
import { computed, inject, onMounted, ref } from 'vue'
import { Activity, Clock3, Download, HardDrive, RefreshCw, Search, Trash2 } from '@lucide/vue'
import { call, command } from './api.js'
import { asArg, display, download, identity } from './model.js'
import { pretty } from './formats.js'

const props = defineProps({ tab: Object, connection: Object })
const tr = inject('tr')
const ask = inject('ask')
const notify = inject('notify')
const busy = ref(false)
const query = ref('')
const raw = ref([])
const size = ref(128)
const finished = ref(false)
const error = ref('')
const total = computed(() => raw.value.reduce((sum, row) => sum + row.bytes, 0))
const tool = computed(() => ({
  slow: { title: tr('慢日志', 'Slow log'), icon: Clock3 },
  memory: { title: tr('内存分析', 'Memory analysis'), icon: HardDrive },
  logs: { title: tr('命令日志', 'Command log'), icon: Activity },
})[props.tab.kind])
const found = computed(() => props.tab.kind === 'logs' ? raw.value.filter(row =>
  row.session === props.connection.id && row.command.toLowerCase().includes(query.value.trim().toLowerCase())) : raw.value)

/** Format byte counts with a unit suitable for a server memory table. */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
  return (bytes / 1024 ** index).toFixed(2) + ' ' + ['B', 'KiB', 'MiB', 'GiB', 'TiB'][index]
}

/** Fetch Redis slow logs, local command logs or all requested memory samples. */
async function refresh() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (props.tab.kind === 'logs') raw.value = await call('Logs')
    else if (props.tab.kind === 'slow') raw.value = await command(props.connection.id, props.tab.db, 'SLOWLOG', 'GET', size.value)
    else await memory()
  } catch (failure) {
    error.value = failure.message
  } finally {
    busy.value = false
  }
}

/** Walk filtered SCAN pages, measure each unique key, and sort by memory use. */
async function memory() {
  finished.value = false
  raw.value = []
  const seen = new Set()
  const results = []
  const pattern = query.value.trim() || '*'
  let cursor = ''
  do {
    const page = await call('Scan', props.connection.id, props.tab.db, pattern, cursor, false, 400)
    const keys = page.keys.filter(key => {
      const value = identity(key)
      if (seen.has(value)) return false
      seen.add(value)
      return true
    })
    if (keys.length) results.push(...await call('Memory', props.connection.id, props.tab.db, keys.map(asArg)))
    cursor = page.cursor
  } while (cursor)
  raw.value = results.sort((a, b) => b.bytes - a.bytes)
  finished.value = true
}

/** Reset command logs locally or clear the server's SLOWLOG on confirmation. */
async function reset() {
  if (!await ask({ title: tr('清空日志', 'Clear log'), text: tool.value.title, danger: true })) return
  try {
    if (props.tab.kind === 'slow') await command(props.connection.id, props.tab.db, 'SLOWLOG', 'RESET')
    else await call('ClearLogs')
    await refresh()
  } catch (failure) {
    notify(failure, true)
  }
}

onMounted(() => { if (props.tab.kind !== 'memory') refresh() })
</script>

<template>
  <div class="panel tools-panel">
    <header class="panel-heading">
      <div class="panel-title"><div class="eyebrow">{{ connection.name }} · DB {{ tab.db }}</div><h1><component :is="tool.icon" :size="23" />{{ tool.title }}</h1></div>
      <div class="heading-actions">
        <button :disabled="busy" @click="refresh()"><RefreshCw :size="15" :class="{ spin: busy }" />{{ tr('刷新', 'Refresh') }}</button>
        <button :disabled="!found.length" @click="download(tab.kind + '.json', JSON.stringify(found, null, 2))"><Download :size="15" />{{ tr('导出', 'Export') }}</button>
        <button v-if="tab.kind !== 'memory'" class="icon danger" :title="tr('清空日志', 'Clear logs')" :disabled="tab.kind === 'slow' && connection.readOnly" @click="reset"><Trash2 :size="16" /></button>
      </div>
    </header>
    <form class="row-tools" @submit.prevent="refresh">
      <div v-if="tab.kind === 'memory' || tab.kind === 'logs'" class="search-field"><Search :size="16" />
        <input v-model="query" :placeholder="tab.kind === 'memory' ? tr('键模式，例如 session:*', 'Key pattern, e.g. session:*') : tr('筛选命令', 'Filter commands')" spellcheck="false">
      </div>
      <label v-else class="soft-check">{{ tr('日志条数', 'Entries') }}<input v-model.number="size" type="number" min="1" max="10000"></label>
      <button v-if="tab.kind !== 'logs'" class="primary" :disabled="busy">{{ tab.kind === 'memory' ? tr('开始分析', 'Analyze') : tr('查询', 'Query') }}</button>
      <span v-if="finished" class="muted">{{ raw.length }} {{ tr('个键', 'keys') }} · {{ formatBytes(total) }}</span>
    </form>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr v-if="tab.kind === 'memory'"><th>{{ tr('键名', 'Key') }}</th><th>{{ tr('内存用量', 'Memory usage') }}</th></tr>
          <tr v-else-if="tab.kind === 'slow'"><th>ID</th><th>{{ tr('时间', 'Time') }}</th><th>{{ tr('耗时（µs）', 'Duration (µs)') }}</th><th>{{ tr('命令', 'Command') }}</th><th>{{ tr('客户端', 'Client') }}</th></tr>
          <tr v-else><th>{{ tr('时间', 'Time') }}</th><th>DB</th><th>{{ tr('命令', 'Command') }}</th><th>{{ tr('耗时（ms）', 'Duration (ms)') }}</th><th>{{ tr('结果', 'Result') }}</th></tr>
        </thead>
        <tbody>
          <template v-if="tab.kind === 'memory'"><tr v-for="row in found.slice(0, 1000)" :key="identity(row.key)"><td class="mono">{{ display(row.key) }}</td><td>{{ formatBytes(row.bytes) }}</td></tr></template>
          <template v-else-if="tab.kind === 'slow'"><tr v-for="row in found" :key="row[0]"><td>{{ row[0] }}</td>
            <td>{{ new Date(Number(row[1]) * 1000).toLocaleString() }}</td><td>{{ row[2] }}</td><td class="mono">{{ pretty(row[3]) }}</td><td>{{ [row[4], row[5]].filter(Boolean).join(' · ') }}</td></tr></template>
          <template v-else><tr v-for="(row, index) in found" :key="index"><td>{{ new Date(row.time).toLocaleString() }}</td>
            <td>{{ row.database }}</td><td class="mono">{{ row.command }}</td><td>{{ row.elapsedMs }}</td><td :class="{ danger: row.error }">{{ row.error || 'OK' }}</td></tr></template>
          <tr v-if="!found.length"><td colspan="5" class="empty-cell">{{ busy ? tr('正在加载…', 'Loading…') : tr('无结果', 'No results') }}</td></tr>
        </tbody>
      </table>
    </div>
    <p v-if="tab.kind === 'memory' && found.length > 1000" class="muted">{{ tr('显示内存占用最高的 1000 个键。导出可查看全部结果。', 'Showing the 1,000 largest keys. Export for the full result.') }}</p>
  </div>
</template>
