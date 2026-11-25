<script setup>
import { computed, inject, onBeforeUnmount, ref } from 'vue'
import { Activity, Download, Play, Square, Trash2 } from '@lucide/vue'
import { call } from './api.js'
import { download } from './model.js'
import EmptyState from './components/EmptyState.vue'
import IconButton from './components/IconButton.vue'
import PanelHeader from './components/PanelHeader.vue'
import StatusNotice from './components/StatusNotice.vue'

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
    <PanelHeader :icon="Activity">
      <template #eyebrow>{{ connection.name }}</template>
      <template #title>{{ tr('实时监控', 'Profiler') }}</template>
      <template #actions>
        <NTag size="small" :type="running ? 'success' : 'default'" :bordered="false" role="status">
          {{ running ? tr('正在监控', 'Capturing') : tr('已停止', 'Stopped') }}
        </NTag>
        <IconButton :icon="Download" :label="tr('导出', 'Export')" :disabled="!matching.length" @click="exportCapture" />
        <IconButton :icon="Trash2" :label="tr('清空记录', 'Clear capture')" :disabled="!rows.length && !dropped" @click="clear" />
        <NButton v-if="running" size="small" :disabled="busy" @click="stop"><Square :size="14" aria-hidden="true" />{{ tr('停止监控', 'Stop profiler') }}</NButton>
        <NButton v-else size="small" type="primary" :loading="busy" :disabled="busy || connection.readOnly" @click="start">
          <Play :size="14" aria-hidden="true" />{{ tr('开始监控', 'Start profiler') }}
        </NButton>
      </template>
    </PanelHeader>
    <StatusNotice v-if="error" tone="error" :title="tr('监控失败', 'Profiler capture failed')" :text="error" />
    <StatusNotice v-if="connection.readOnly" tone="info" :text="tr('只读连接无法启动监控', 'Profiler is unavailable on read-only connections')" />
    <div class="row-tools">
      <label class="profiler-filter">
        {{ tr('筛选监控记录', 'Filter capture') }}
        <NInput v-model:value="filter" size="small" clearable
          :placeholder="tr('命令、客户端或数据库', 'Command, client or database')" />
      </label>
      <span class="muted">{{ matching.length }} / {{ rows.length }} {{ tr('条记录', 'events') }}</span>
      <span v-if="dropped" class="muted">{{ tr('采集缓冲区丢弃', 'Capture buffer dropped') }} {{ dropped }}</span>
      <span v-if="connection.mode === 'cluster'" class="muted">{{ tr('监控一个主节点', 'Captures one primary node') }}</span>
    </div>
    <EmptyState v-if="!matching.length" compact>{{ rows.length ? tr('没有匹配的命令', 'No matching commands') : tr('暂无监控记录', 'No captured commands') }}</EmptyState>
    <div v-else class="table-wrap">
      <NTable size="small" :bordered="false" class="data-table profiler-table">
        <thead><tr><th>{{ tr('时间', 'Time') }}</th><th>DB</th><th>{{ tr('客户端', 'Client') }}</th><th>{{ tr('命令', 'Command') }}</th></tr></thead>
        <tbody>
          <tr v-for="row in matching" :key="row.id">
            <td>{{ new Date(row.time).toLocaleTimeString() }}</td><td>{{ row.db || '—' }}</td>
            <td class="mono">{{ row.client || '—' }}</td><td class="mono">{{ row.command }}</td>
          </tr>
        </tbody>
      </NTable>
    </div>
  </div>
</template>

<style scoped>
.profiler-panel { padding: 16px; gap: 12px; }
.profiler-panel :deep(.shared-panel-header) { flex-wrap: wrap; }
.profiler-panel :deep(.shared-panel-header__actions) { flex: 0 1 auto; flex-wrap: wrap; }
.profiler-filter { display: grid; gap: 4px; flex: 1 1 205px; min-width: 0; max-width: 340px; color: var(--muted); }
.table-wrap { border-radius: 6px; }
.profiler-table { min-width: 320px; }
.profiler-table :deep(th), .profiler-table :deep(td) { height: 28px; padding-block: 4px; }
.profiler-table td:nth-child(-n + 3) { white-space: nowrap; width: 1%; }
.profiler-table td:last-child { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
