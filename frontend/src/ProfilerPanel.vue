<script setup>
import { computed, inject, onBeforeUnmount, ref } from 'vue'
import { Activity, Download, Play, Square, Trash2 } from '@lucide/vue'
import { call } from './api.js'
import { download } from './model.js'

const props = defineProps({ tab: Object, connection: Object })
const tr = inject('tr')
const rows = ref([])
const filter = ref('')
const busy = ref(false)
const running = ref(false)
const dropped = ref(0)
const error = ref('')
let activeToken = ''
let sequence = 0
let timer
let disposed = false
const limit = 1000

const matching = computed(() => {
  const query = filter.value.trim().toLowerCase()
  return rows.value.filter(row => row.raw.toLowerCase().includes(query))
})

/** Split a MONITOR line while preserving Redis's quoted, binary-safe arguments. */
function decode(event) {
  const raw = String(event.value)
  const parts = /^(\d+(?:\.\d+)?) \[(\d+) (.*?)\] (.*)$/.exec(raw)
  const time = parts ? new Date(Number(parts[1]) * 1000).toISOString() : event.time
  return { id: sequence++, time, db: parts?.[2] ?? '', client: parts?.[3] ?? '', command: parts?.[4] ?? raw, raw }
}

/** Drain accumulated Redis commands and retain a bounded history for the table. */
async function poll(token) {
  if (activeToken !== token || disposed) return
  try {
    const batch = await call('PollFeed', token)
    if (activeToken !== token || disposed) return
    if (batch.messages.length) rows.value = [...batch.messages.map(decode).reverse(), ...rows.value].slice(0, limit)
    dropped.value += batch.dropped
    if (batch.error) throw new Error(batch.error)
    timer = setTimeout(() => poll(token), 350)
  } catch (failure) {
    if (activeToken !== token || disposed) return
    error.value = failure.message || String(failure)
    await stop()
  }
}

/** Start a dedicated MONITOR connection only after the user requests it. */
async function start() {
  if (busy.value || running.value || props.connection.readOnly) return
  const token = crypto.randomUUID()
  busy.value = true
  error.value = ''
  try {
    await call('StartFeed', props.connection.id, props.tab.db, token, 'MONITOR', [])
    if (disposed) {
      await call('StopFeed', token)
      return
    }
    activeToken = token
    running.value = true
    void poll(token)
  } catch (failure) {
    if (!disposed) error.value = failure.message || String(failure)
  } finally {
    busy.value = false
  }
}

/** Stop polling, close the Redis socket, and leave the captured rows visible. */
async function stop() {
  const token = activeToken
  activeToken = ''
  clearTimeout(timer)
  running.value = false
  busy.value = true
  try {
    await call('StopFeed', token)
  } catch (failure) {
    if (!disposed && !error.value) error.value = failure.message || String(failure)
  } finally {
    busy.value = false
  }
}

/** Clear the retained capture and the current server drop counter. */
function clear() {
  rows.value = []
  dropped.value = 0
}

/** Export the displayed capture for offline troubleshooting. */
function exportCapture() {
  const data = matching.value.map(({ time, db, client, command }) => ({ time, db, client, command }))
  download('redis-profiler.json', JSON.stringify(data, null, 2))
}

onBeforeUnmount(() => {
  disposed = true
  if (running.value) void stop()
})
</script>

<template>
  <div class="panel profiler-panel">
    <header class="panel-heading">
      <div class="panel-title">
        <div class="eyebrow">{{ connection.name }}</div>
        <h1><Activity :size="23" />{{ tr('实时监控', 'Profiler') }}</h1>
      </div>
      <div class="heading-actions">
        <NButton size="small" :disabled="!matching.length" @click="exportCapture"><Download :size="15" />{{ tr('导出', 'Export') }}</NButton>
        <NButton size="small" :disabled="!rows.length" @click="clear"><Trash2 :size="15" />{{ tr('清空记录', 'Clear capture') }}</NButton>
        <NButton v-if="running" size="small" :disabled="busy" @click="stop"><Square :size="14" />{{ tr('停止监控', 'Stop profiler') }}</NButton>
        <NButton v-else size="small" type="primary" :loading="busy" :disabled="busy || connection.readOnly" @click="start">
          <Play :size="14" />{{ tr('开始监控', 'Start profiler') }}
        </NButton>
      </div>
    </header>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <div class="row-tools">
      <NInput v-model:value="filter" class="profiler-filter" size="small" clearable
        :placeholder="tr('筛选命令、客户端或数据库', 'Filter commands, clients or databases')"
        :input-props="{ 'aria-label': tr('筛选监控记录', 'Filter capture') }" />
      <NTag size="small" :type="running ? 'success' : 'default'" :bordered="false">
        {{ running ? tr('正在监控', 'Capturing') : tr('已停止', 'Stopped') }}
      </NTag>
      <span class="muted">{{ matching.length }} / {{ rows.length }} {{ tr('条记录', 'events') }}</span>
      <span v-if="dropped" class="muted">{{ tr('采集缓冲区丢弃', 'Capture buffer dropped') }} {{ dropped }}</span>
      <span v-if="connection.mode === 'cluster'" class="muted">{{ tr('监控一个主节点', 'Captures one primary node') }}</span>
      <span v-if="connection.readOnly" class="muted">{{ tr('只读连接无法启动监控', 'Profiler is unavailable on read-only connections') }}</span>
    </div>
    <div class="table-wrap">
      <NTable size="small" :bordered="false" class="data-table profiler-table">
        <thead><tr><th>{{ tr('时间', 'Time') }}</th><th>DB</th><th>{{ tr('客户端', 'Client') }}</th><th>{{ tr('命令', 'Command') }}</th></tr></thead>
        <tbody>
          <tr v-for="row in matching" :key="row.id">
            <td>{{ new Date(row.time).toLocaleTimeString() }}</td><td>{{ row.db || '—' }}</td>
            <td class="mono">{{ row.client || '—' }}</td><td class="mono">{{ row.command }}</td>
          </tr>
          <tr v-if="!matching.length"><td colspan="4" class="empty-cell">{{ tr('暂无监控记录', 'No captured commands') }}</td></tr>
        </tbody>
      </NTable>
    </div>
  </div>
</template>

<style scoped>
.profiler-filter { flex: 1 1 205px; max-width: 340px; }
.profiler-table td:nth-child(-n + 3) { white-space: nowrap; width: 1%; }
.profiler-table td:last-child { white-space: pre-wrap; }
</style>
