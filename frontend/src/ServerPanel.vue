<script setup>
import { computed, inject, onUnmounted, ref, shallowRef, watch } from 'vue'
import { Activity, Cpu, Database, HardDrive, RefreshCw, Server, Users } from '@lucide/vue'
import { call } from './api.js'
import { parseInfo } from './model.js'
import EmptyState from './components/EmptyState.vue'
import PanelHeader from './components/PanelHeader.vue'
import StatusNotice from './components/StatusNotice.vue'

const props = defineProps({ connection: Object, db: Number, info: Object, visible: Boolean })
const emit = defineEmits(['info'])
const tr = inject('tr')
const busy = ref(false)
const auto = ref(false)
const raw = ref(false)
const points = ref([])
const snapshot = shallowRef(props.info ?? null)
const error = ref('')
const lastSuccess = ref(null)
const latency = ref(null)
const hasInfo = computed(() => Boolean(snapshot.value?.info?.trim()))
const freshness = computed(() => {
  if (error.value) return hasInfo.value ? 'stale' : 'error'
  if (busy.value && !lastSuccess.value) return 'loading'
  return hasInfo.value ? 'ready' : 'empty'
})
const status = computed(() => ({
  loading: tr('正在加载', 'Loading'),
  ready: tr('数据最新', 'Up to date'),
  stale: tr('缓存数据', 'Cached data'),
  error: tr('刷新失败', 'Refresh failed'),
  empty: tr('无 INFO 数据', 'No INFO data'),
})[freshness.value])
const sections = computed(() => parseInfo(snapshot.value?.info))
const fields = computed(() => Object.assign({}, ...Object.values(sections.value)))
const cards = computed(() => [
  { label: tr('已用内存', 'Used memory'), value: fields.value.used_memory_human, detail: tr('峰值', 'Peak') + ' ' + (fields.value.used_memory_peak_human || '—'), icon: HardDrive },
  { label: tr('键数量', 'Database keys'), value: lastSuccess.value ? snapshot.value?.size?.toLocaleString() : undefined, detail: 'DB ' + props.db, icon: Database },
  { label: tr('客户端连接', 'Connected clients'), value: fields.value.connected_clients, detail: tr('阻塞', 'Blocked') + ' ' + (fields.value.blocked_clients || '0'), icon: Users },
  { label: tr('每秒操作', 'Operations per sec'), value: fields.value.instantaneous_ops_per_sec, detail: tr('累计命令', 'Total commands') + ' ' + (fields.value.total_commands_processed || '—'), icon: Activity },
])
const maximum = computed(() => Math.max(1, ...points.value))
let timer
let revision = 0
let disposed = false

/** Refresh INFO and record one sample for the activity history. */
async function refresh() {
  if (busy.value || disposed) return
  busy.value = true
  const request = revision
  const started = performance.now()
  try {
    const info = await call('Info', props.connection.id, props.db)
    if (disposed || request !== revision) return
    snapshot.value = info
    error.value = ''
    lastSuccess.value = new Date()
    latency.value = Math.round(performance.now() - started)
    emit('info', info)
    const instant = parseInfo(info.info).Stats?.instantaneous_ops_per_sec
    if (instant !== undefined) points.value = [...points.value, Number(instant) || 0].slice(-32)
  } catch (failure) {
    if (!disposed && request === revision) error.value = failure.message || String(failure)
  } finally {
    busy.value = false
    if (!disposed && request !== revision) void refresh()
  }
}

watch([() => props.connection.id, () => props.db], () => {
  revision++
  snapshot.value = null
  lastSuccess.value = null
  latency.value = null
  error.value = ''
  points.value = []
  void refresh()
}, { flush: 'sync' })
void refresh()
watch(() => [auto.value, props.visible], ([enabled, visible]) => {
  clearInterval(timer)
  if (enabled && visible) timer = setInterval(refresh, 2500)
})
onUnmounted(() => {
  disposed = true
  clearInterval(timer)
})
</script>

<template>
  <div class="panel server-panel">
    <PanelHeader :icon="Server">
      <template #title>{{ connection.name }}</template>
      <template #actions>
        <label class="soft-check"><NSwitch v-model:value="auto" size="small" :aria-label="tr('自动刷新', 'Auto-refresh')" /> {{ tr('自动刷新', 'Auto-refresh') }}</label>
        <span class="soft-check">{{ tr('最后成功', 'Last successful refresh') }} · {{ lastSuccess?.toLocaleTimeString() ?? '—' }}</span>
        <NButton size="small" :loading="busy" :disabled="busy" @click="refresh()"><RefreshCw :size="14" aria-hidden="true" />{{ tr('刷新', 'Refresh') }}</NButton>
      </template>
    </PanelHeader>
    <div class="server-summary">
      <div><span>{{ tr('服务器', 'Server') }}</span><strong>{{ connection.addr }}</strong></div>
      <div><span>{{ tr('数据库与模式', 'Database and mode') }}</span><strong>DB {{ db }} · {{ snapshot?.cluster ? 'cluster' : connection.mode }}</strong></div>
      <div><span>{{ tr('INFO 延迟', 'INFO latency') }}</span><strong>{{ latency === null ? '—' : `${latency} ms` }}</strong></div>
      <div><span>{{ tr('刷新状态', 'Refresh status') }}</span><strong>{{ busy && lastSuccess ? tr('正在刷新', 'Refreshing') : status }}</strong></div>
    </div>
    <StatusNotice v-if="error" :tone="freshness" :title="tr('服务器刷新失败', 'Server refresh failed')" :text="error" retry @retry="refresh" />
    <StatusNotice v-else-if="freshness === 'loading'" tone="info" :text="tr('正在读取服务器信息…', 'Loading server information…')" />
    <EmptyState v-else-if="freshness === 'empty'" compact>{{ tr('服务器未返回 INFO 数据。', 'The server returned no INFO data.') }}</EmptyState>
    <div v-if="snapshot" class="metric-grid">
      <NCard v-for="card in cards" :key="card.label" size="small" class="metric">
        <div class="metric-label"><component :is="card.icon" :size="17" /><span>{{ card.label }}</span></div>
        <strong>{{ card.value ?? '—' }}</strong><small>{{ card.detail }}</small>
      </NCard>
    </div>
    <div v-if="hasInfo" class="info-box">
      <header><Cpu :size="17" /><h2>{{ tr('操作活动', 'Command activity') }}</h2><span class="spacer"></span><span class="muted">{{ tr('峰值', 'Peak') }} {{ maximum }}</span></header>
      <div class="activity-graph" role="img" :aria-label="tr('每秒操作历史', 'Operations per second over time')">
        <div v-for="(point, i) in points" :key="i" class="activity-bar" :title="String(point)" :style="{ height: Math.max(5, point / maximum * 100) + '%' }"></div>
      </div>
    </div>
    <div v-if="hasInfo" class="info-box">
      <header><Activity :size="17" /><h2>{{ tr('服务器信息', 'Server information') }}</h2><span class="spacer"></span>
        <NButton size="small" quaternary class="flat" :aria-pressed="raw" @click="raw = !raw">{{ raw ? tr('分类查看', 'Show sections') : tr('原始 INFO', 'Raw INFO') }}</NButton></header>
      <pre v-if="raw">{{ snapshot.info }}</pre>
      <div v-else class="info-sections">
        <details v-for="(values, title) in sections" :key="title" :open="title === 'Server'">
          <summary>{{ title }} <span>{{ Object.keys(values).length }}</span></summary>
          <dl><template v-for="(value, key) in values" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl>
        </details>
        <EmptyState v-if="!Object.keys(sections).length" compact>{{ tr('没有可显示的 INFO 分区。', 'No INFO sections to display.') }}</EmptyState>
      </div>
    </div>
  </div>
</template>

<style scoped>
.server-panel { container-type: inline-size; padding: 16px; gap: 12px; }
.server-panel :deep(.shared-panel-header) { flex-wrap: wrap; }
.server-panel :deep(.shared-panel-header__actions) { flex: 0 1 auto; flex-wrap: wrap; }
.server-summary, .info-box { border-radius: 6px; }
.server-summary div { padding: 8px 12px; overflow-wrap: anywhere; }
.metric-grid { gap: 8px; }
.metric { border-radius: 6px; }
.metric strong { font-size: 19px; }
.info-box header { flex-wrap: wrap; min-height: 32px; }
.info-box h2 { font-size: 14px; }
@container (max-width: 700px) {
  .server-summary, .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .server-summary div:nth-child(3) { border-left: 0; }
  .server-summary div:nth-child(n + 3) { border-top: 1px solid var(--border); }
}
</style>
