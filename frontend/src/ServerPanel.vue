<script setup>
import { computed, inject, onUnmounted, ref, watch } from 'vue'
import { Activity, Cpu, Database, HardDrive, RefreshCw, Server, Users } from '@lucide/vue'
import { call } from './api.js'
import { parseInfo } from './model.js'

const props = defineProps({ connection: Object, db: Number, info: Object, visible: Boolean })
const emit = defineEmits(['info'])
const tr = inject('tr')
const notify = inject('notify')
const busy = ref(false)
const auto = ref(false)
const raw = ref(false)
const points = ref([])
const sections = computed(() => parseInfo(props.info.info))
const fields = computed(() => Object.assign({}, ...Object.values(sections.value)))
const cards = computed(() => [
  { label: tr('已用内存', 'Used memory'), value: fields.value.used_memory_human, detail: tr('峰值', 'Peak') + ' ' + (fields.value.used_memory_peak_human || '—'), icon: HardDrive },
  { label: tr('键数量', 'Database keys'), value: props.info.size.toLocaleString(), detail: 'DB ' + props.db, icon: Database },
  { label: tr('客户端连接', 'Connected clients'), value: fields.value.connected_clients, detail: tr('阻塞', 'Blocked') + ' ' + (fields.value.blocked_clients || '0'), icon: Users },
  { label: tr('每秒操作', 'Operations per sec'), value: fields.value.instantaneous_ops_per_sec, detail: tr('累计命令', 'Total commands') + ' ' + (fields.value.total_commands_processed || '—'), icon: Activity },
])
const maximum = computed(() => Math.max(1, ...points.value))
let timer

/** Refresh INFO and record one sample for the activity history. */
async function refresh(showError = true) {
  if (busy.value) return
  busy.value = true
  const db = props.db
  try {
    const info = await call('Info', props.connection.id, db)
    if (db !== props.db) return
    emit('info', info)
    const instant = parseInfo(info.info).Stats?.instantaneous_ops_per_sec
    if (instant !== undefined) points.value = [...points.value, Number(instant) || 0].slice(-32)
  } catch (error) {
    if (showError) notify(error, true)
  } finally {
    busy.value = false
    if (db !== props.db) refresh()
  }
}

watch(() => props.db, () => refresh(), { immediate: true })
watch(() => [auto.value, props.visible], ([enabled, visible]) => {
  clearInterval(timer)
  if (enabled && visible) timer = setInterval(() => refresh(false), 2500)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="panel server-panel">
    <header class="panel-heading">
      <div class="panel-title">
        <div class="eyebrow"><span class="dot"></span>{{ connection.addr }}</div>
        <h1><Server :size="23" />{{ connection.name }}</h1>
      </div>
      <div class="heading-actions">
        <label class="soft-check"><NSwitch v-model:value="auto" size="small" :aria-label="tr('自动刷新', 'Auto-refresh')" /> {{ tr('自动刷新', 'Auto-refresh') }}</label>
        <NButton size="small" @click="refresh()"><RefreshCw :size="15" :class="{ spin: busy }" />{{ tr('刷新', 'Refresh') }}</NButton>
      </div>
    </header>
    <div class="server-summary">
      <div><span>{{ tr('Redis 版本', 'Redis version') }}</span><strong>{{ fields.redis_version || fields.valkey_version || '—' }}</strong></div>
      <div><span>{{ tr('运行模式', 'Mode') }}</span><strong>{{ info.cluster ? 'cluster' : connection.mode }}</strong></div>
      <div><span>{{ tr('节点角色', 'Role') }}</span><strong>{{ fields.role || '—' }}</strong></div>
      <div><span>{{ tr('运行天数', 'Uptime (days)') }}</span><strong>{{ fields.uptime_in_days || '0' }}</strong></div>
    </div>
    <div class="metric-grid">
      <NCard v-for="card in cards" :key="card.label" size="small" class="metric">
        <div class="metric-label"><component :is="card.icon" :size="17" /><span>{{ card.label }}</span></div>
        <strong>{{ card.value ?? '—' }}</strong><small>{{ card.detail }}</small>
      </NCard>
    </div>
    <div class="info-box">
      <header><Cpu :size="17" /><h2>{{ tr('操作活动', 'Command activity') }}</h2><span class="spacer"></span><span class="muted">{{ tr('峰值', 'Peak') }} {{ maximum }}</span></header>
      <div class="activity-graph" role="img" :aria-label="tr('每秒操作历史', 'Operations per second over time')">
        <div v-for="(point, i) in points" :key="i" class="activity-bar" :title="String(point)" :style="{ height: Math.max(5, point / maximum * 100) + '%' }"></div>
      </div>
    </div>
    <div class="info-box">
      <header><Activity :size="17" /><h2>{{ tr('服务器信息', 'Server information') }}</h2><span class="spacer"></span>
        <NButton size="small" quaternary class="flat" :aria-pressed="raw" @click="raw = !raw">{{ raw ? tr('分类查看', 'Show sections') : tr('原始 INFO', 'Raw INFO') }}</NButton></header>
      <pre v-if="raw">{{ info.info }}</pre>
      <div v-else class="info-sections">
        <details v-for="(values, title) in sections" :key="title" :open="title === 'Server'">
          <summary>{{ title }} <span>{{ Object.keys(values).length }}</span></summary>
          <dl><template v-for="(value, key) in values" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl>
        </details>
        <p v-if="!Object.keys(sections).length" class="muted">{{ tr('服务器未返回 INFO 数据。', 'The server returned no INFO data.') }}</p>
      </div>
    </div>
  </div>
</template>
