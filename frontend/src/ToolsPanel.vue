<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { Activity, Clock3, Download, HardDrive, RefreshCw, Settings, Trash2 } from '@lucide/vue'
import { call } from './api.js'
import { asArg, display, download, identity } from './model.js'
import { pretty } from './formats.js'
import SlowLogSettings from './SlowLogSettings.vue'
import EmptyState from './components/EmptyState.vue'
import IconButton from './components/IconButton.vue'
import PanelHeader from './components/PanelHeader.vue'
import StatusNotice from './components/StatusNotice.vue'

const props = defineProps({ tab: Object, connection: Object, visible: Boolean })
const tr = inject('tr')
const ask = inject('ask')
const filterId = useId()
const busy = ref(false)
const clearing = ref(false)
const query = ref('')
const database = ref(props.tab.db)
const raw = ref([])
const size = ref(128)
const finished = ref(false)
const error = ref('')
const resetError = ref('')
let disposed = false
const node = ref('')
const nodes = ref([])
const autoInterval = ref(0)
const settingsNode = ref(null)
const loadedNode = ref(null)
const total = computed(() => raw.value.reduce((sum, row) => sum + row.bytes, 0))
const tool = computed(() => ({
  slow: { title: tr('慢日志', 'Slow log'), icon: Clock3 },
  memory: { title: tr('内存分析', 'Memory analysis'), icon: HardDrive },
  logs: { title: tr('命令日志', 'Command log'), icon: Activity },
})[props.tab.kind])
const found = computed(() => {
  if (props.tab.kind === 'slow' && loadedNode.value !== node.value) return []
  if (props.tab.kind !== 'logs') return raw.value
  const filter = query.value.trim().toLowerCase()
  return raw.value.filter(row => row.session === props.connection.id &&
    (database.value === 'all' || row.database === database.value) && row.command.toLowerCase().includes(filter))
})
const slowRows = computed(() => props.tab.kind === 'slow' ? found.value.map(row => ({
  id: row[0],
  time: new Date(Number(row[1]) * 1000).toLocaleString(),
  duration: row[2],
  command: pretty(row[3]),
  client: [row[4], row[5]].filter(Boolean).join(' · '),
})) : [])
const scope = computed(() => props.tab.kind === 'logs' && database.value === 'all'
  ? tr('所有数据库', 'All databases')
  : `DB ${props.tab.kind === 'logs' ? database.value : props.tab.db}`)
const memoryPattern = computed(() => query.value.trim() || '*')
const resultPattern = ref('')
const memoryProgress = ref(null)
const memoryProgressText = computed(() => {
  const { pages, matched, measured } = memoryProgress.value
  return tr(
    `已扫描 ${pages.toLocaleString()} 批 · 匹配 ${matched.toLocaleString()} 个键 · 已测量 ${measured.toLocaleString()} 个键`,
    `${pages.toLocaleString()} scan batches · ${matched.toLocaleString()} matching keys · ${measured.toLocaleString()} measured keys`,
  )
})
const staleMemory = computed(() => props.tab.kind === 'memory' && finished.value &&
  (Boolean(error.value) || resultPattern.value !== memoryPattern.value))
const canReset = computed(() => !busy.value && !clearing.value && (
  props.tab.kind === 'logs' || (props.tab.kind === 'slow' && !error.value && !props.connection.readOnly &&
    loadedNode.value === node.value && (props.connection.mode !== 'cluster' || Boolean(node.value)))
))

/** Format byte counts with a unit suitable for a server memory table. */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
  return (bytes / 1024 ** index).toFixed(2) + ' ' + ['B', 'KiB', 'MiB', 'GiB', 'TiB'][index]
}

/** Fetch Redis slow logs, local command logs or all requested memory samples. */
async function refresh(reloadNodes = false) {
  if (busy.value || clearing.value || disposed) return
  busy.value = true
  try {
    if (props.tab.kind === 'logs') raw.value = await call('Logs')
    else if (props.tab.kind === 'slow') {
      if (props.connection.mode === 'cluster' && (reloadNodes || !nodes.value.length)) {
        const addresses = await call('SlowLogNodes', props.connection.id, props.tab.db)
        nodes.value = addresses
        if (!addresses.includes(node.value)) node.value = addresses[0] || ''
      }
      const result = await call('SlowLogEntries', props.connection.id, props.tab.db, node.value, size.value || 128)
      raw.value = result.value ?? []
      loadedNode.value = node.value
    } else await memory()
    error.value = ''
  } catch (failure) {
    error.value = failure.message || String(failure)
  } finally {
    busy.value = false
  }
}

/** Walk filtered SCAN pages, measure each unique key, and sort by memory use. */
async function memory() {
  memoryProgress.value = { pages: 0, matched: 0, measured: 0, measuring: false }
  const progress = memoryProgress.value
  const seen = new Set()
  const results = []
  const pattern = memoryPattern.value
  const { db } = props.tab
  const { id } = props.connection
  let cursor = ''
  do {
    const page = await call('Scan', id, db, pattern, cursor, false, 400)
    if (disposed) return
    const keys = page.keys.filter(key => {
      const value = identity(key)
      if (seen.has(value)) return false
      seen.add(value)
      return true
    })
    progress.pages++
    progress.matched += keys.length
    if (keys.length) {
      progress.measuring = true
      const entries = await call('Memory', id, db, keys.map(asArg))
      if (disposed) return
      results.push(...entries)
      progress.measured += entries.length
      progress.measuring = false
    }
    cursor = page.cursor
  } while (cursor)
  raw.value = results.sort((a, b) => b.bytes - a.bytes)
  resultPattern.value = pattern
  finished.value = true
}

/** Reset command logs locally or clear the server's SLOWLOG on confirmation. */
async function reset() {
  if (!canReset.value) return
  const target = node.value
  const slow = props.tab.kind === 'slow'
  const id = props.connection.id
  const db = props.tab.db
  const text = slow ? target || props.connection.name : tr('清空所有连接和数据库的本地命令日志？', 'Clear local command logs for all connections and databases?')
  clearing.value = true
  resetError.value = ''
  try {
    if (!await ask({ title: tr('清空日志', 'Clear log'), text, danger: true }) || disposed) return
    if (slow) {
      if (props.connection.readOnly || id !== props.connection.id || db !== props.tab.db || target !== node.value) return
      await call('ResetSlowLog', id, db, target)
    } else await call('ClearLogs')
    raw.value = []
  } catch (failure) {
    resetError.value = failure.message || String(failure)
    return
  } finally {
    clearing.value = false
  }
  await refresh()
}

onMounted(() => { if (props.tab.kind !== 'memory') refresh() })
onBeforeUnmount(() => { disposed = true })
watch(() => props.tab.db, db => { database.value = db })
watch([autoInterval, () => props.visible], ([seconds, visible], _, onCleanup) => {
  if (props.tab.kind !== 'slow' || !visible || !seconds) return
  void refresh()
  const timer = setInterval(() => refresh(), seconds * 1000)
  onCleanup(() => clearInterval(timer))
})
</script>

<template>
  <div class="panel tools-panel">
    <PanelHeader :icon="tool.icon">
      <template #eyebrow>{{ connection.name }} · {{ scope }}</template>
      <template #title>{{ tool.title }}</template>
      <template #actions>
        <NButton size="small" :loading="busy" :disabled="busy || clearing" @click="refresh(true)"><RefreshCw :size="14" aria-hidden="true" />{{ tr('刷新', 'Refresh') }}</NButton>
        <NButton v-if="tab.kind === 'slow'" size="small" :disabled="clearing || (connection.mode === 'cluster' && !node)" @click="settingsNode = node">
          <Settings :size="14" aria-hidden="true" />{{ tr('慢日志设置', 'Slow log settings') }}
        </NButton>
        <NButton size="small" :disabled="busy || clearing || !found.length || staleMemory || Boolean(error)" @click="download(tab.kind + '.json', JSON.stringify(found, null, 2))"><Download :size="14" aria-hidden="true" />{{ tr('导出', 'Export') }}</NButton>
        <IconButton v-if="tab.kind !== 'memory'" :icon="Trash2" :label="tr('清空日志', 'Clear logs')" danger :disabled="!canReset" @click="reset" />
      </template>
    </PanelHeader>
    <form class="row-tools" @submit.prevent="refresh()">
      <template v-if="tab.kind === 'memory' || tab.kind === 'logs'">
        <div class="tool-filter">
          <label :for="filterId">{{ tab.kind === 'memory' ? tr('键模式', 'Key pattern') : tr('筛选命令', 'Filter commands') }}</label>
          <NInput v-model:value="query" size="small" clearable
            :placeholder="tab.kind === 'memory' ? tr('键模式，例如 session:*', 'Key pattern, e.g. session:*') : tr('筛选命令', 'Filter commands')"
            :input-props="{ id: filterId, spellcheck: false }" />
        </div>
        <label v-if="tab.kind === 'logs'" class="tool-filter">
          {{ tr('数据库范围', 'Database scope') }}
          <select v-model="database">
            <option :value="tab.db">DB {{ tab.db }}</option>
            <option value="all">{{ tr('所有数据库', 'All databases') }}</option>
          </select>
        </label>
      </template>
      <template v-else>
        <label v-if="nodes.length" class="soft-check">{{ tr('主节点', 'Primary node') }}
          <select v-model="node" :disabled="busy || clearing" @change="refresh()"><option v-for="address in nodes" :key="address">{{ address }}</option></select>
        </label>
        <label class="soft-check">{{ tr('日志条数', 'Entries') }}<input v-model.number="size" type="number" min="1" max="10000"></label>
        <label class="soft-check">{{ tr('自动刷新', 'Auto-refresh') }}
          <select v-model.number="autoInterval"><option :value="0">{{ tr('关闭', 'Off') }}</option>
            <option v-for="seconds in [1, 3, 5, 10, 30]" :key="seconds" :value="seconds">{{ seconds }} {{ tr('秒', 'sec') }}</option>
          </select>
        </label>
      </template>
      <NButton size="small" type="primary" attr-type="submit" v-if="tab.kind !== 'logs'" class="primary" :disabled="busy || clearing">{{ tab.kind === 'memory' ? tr('开始分析', 'Analyze') : tr('查询', 'Query') }}</NButton>
      <span v-if="finished" class="muted">{{ raw.length }} {{ tr('个键', 'keys') }} · {{ formatBytes(total) }}</span>
    </form>
    <StatusNotice v-if="tab.kind === 'slow' && connection.readOnly" tone="info" :text="tr('只读连接', 'Read-only connection')" />
    <StatusNotice v-if="resetError" tone="error" :title="tr('清空日志失败', 'Could not clear logs')" :text="resetError" />
    <StatusNotice v-if="busy && tab.kind === 'memory' && memoryProgress" tone="info"
      :title="memoryProgress.measuring ? tr('正在测量键的内存占用…', 'Measuring key memory usage…') : tr('正在扫描键…', 'Scanning keys…')"
      :text="memoryProgressText" />
    <StatusNotice v-else-if="busy && tab.kind !== 'memory'" tone="info" :text="tr('正在加载日志…', 'Loading logs…')" />
    <StatusNotice v-if="staleMemory" tone="stale" :text="error || tr('键模式已更改。', 'The key pattern has changed.')" @retry="refresh()" />
    <StatusNotice v-else-if="error" :tone="found.length ? 'stale' : 'error'" :title="tr('查询失败', 'Query failed')" :text="error" retry @retry="refresh(true)" />
    <EmptyState v-if="!found.length && !busy && !error && !clearing && !staleMemory" compact>
      {{ tab.kind === 'memory' && !finished ? tr('输入键模式并开始分析。', 'Enter a key pattern and run the analysis.') : tr('无结果', 'No results') }}
    </EmptyState>
    <div v-if="found.length" class="table-wrap">
      <NTable size="small" :bordered="false" class="data-table" :class="{ 'slow-log-table': tab.kind === 'slow' }">
        <thead>
          <tr v-if="tab.kind === 'memory'"><th>{{ tr('键名', 'Key') }}</th><th>{{ tr('内存用量', 'Memory usage') }}</th></tr>
          <tr v-else-if="tab.kind === 'slow'"><th>ID</th><th>{{ tr('时间', 'Time') }}</th><th>{{ tr('耗时（µs）', 'Duration (µs)') }}</th><th>{{ tr('命令', 'Command') }}</th><th>{{ tr('客户端', 'Client') }}</th></tr>
          <tr v-else><th>{{ tr('时间', 'Time') }}</th><th>DB</th><th>{{ tr('命令', 'Command') }}</th><th>{{ tr('耗时（ms）', 'Duration (ms)') }}</th><th>{{ tr('结果', 'Result') }}</th></tr>
        </thead>
        <tbody>
          <template v-if="tab.kind === 'memory'"><tr v-for="row in found.slice(0, 1000)" :key="identity(row.key)"><td class="mono">{{ display(row.key) }}</td><td>{{ formatBytes(row.bytes) }}</td></tr></template>
          <template v-else-if="tab.kind === 'slow'">
            <tr v-for="row in slowRows" :key="row.id">
              <td :title="String(row.id)">{{ row.id }}</td>
              <td :title="row.time">{{ row.time }}</td>
              <td :title="String(row.duration)">{{ row.duration }}</td>
              <td class="mono" :title="row.command">{{ row.command }}</td>
              <td :title="row.client">{{ row.client }}</td>
            </tr>
          </template>
          <template v-else><tr v-for="(row, index) in found" :key="index"><td>{{ new Date(row.time).toLocaleString() }}</td>
            <td>{{ row.database }}</td><td class="mono">{{ row.command }}</td><td>{{ row.elapsedMs }}</td><td :class="{ danger: row.error }">{{ row.error || 'OK' }}</td></tr></template>
        </tbody>
      </NTable>
    </div>
    <p v-if="tab.kind === 'memory' && found.length > 1000" class="muted">{{ tr('显示内存占用最高的 1000 个键。导出可查看全部结果。', 'Showing the 1,000 largest keys. Export for the full result.') }}</p>
    <SlowLogSettings v-if="settingsNode !== null" :tab="tab" :connection="connection" :node="settingsNode" @close="settingsNode = null" />
  </div>
</template>

<style scoped>
.tools-panel { padding: 16px; gap: 12px; }
.tools-panel :deep(.shared-panel-header) { flex-wrap: wrap; }
.tools-panel :deep(.shared-panel-header__actions) { flex: 0 1 auto; flex-wrap: wrap; }
.row-tools { align-items: end; gap: 8px 12px; }
.tool-filter { display: grid; gap: 4px; min-width: 0; color: var(--muted); }
.tool-filter:first-child { flex: 1 1 205px; max-width: 340px; }
.soft-check { flex-wrap: wrap; }
.row-tools select { max-width: 100%; }
.table-wrap { border-radius: 6px; }
.data-table { min-width: 320px; }
.data-table :deep(th), .data-table :deep(td) { height: 28px; padding-block: 4px; }
.data-table td { overflow-wrap: anywhere; }
.slow-log-table { min-width: 520px; table-layout: fixed; }
.slow-log-table th:nth-child(1) { width: 64px; }
.slow-log-table th:nth-child(2) { width: 156px; }
.slow-log-table th:nth-child(3) { width: 104px; }
.slow-log-table th:nth-child(5) { width: 25%; }
.slow-log-table td {
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
