<script setup>
import { inject, onMounted, reactive, ref, useId } from 'vue'
import { X } from '@lucide/vue'
import { call } from './api.js'
import IconButton from './components/IconButton.vue'
import StatusNotice from './components/StatusNotice.vue'
import WorkspaceDialog from './WorkspaceDialog.vue'

const props = defineProps({ tab: Object, connection: Object, node: String })
const emit = defineEmits(['close'])
const tr = inject('tr')
const values = reactive({})
const original = reactive({})
const loading = ref(true)
const saving = ref('')
const error = ref('')
const results = reactive({})
const lastSaved = ref('')
const formId = useId()
const titleId = `${formId}-title`
const descriptionId = `${formId}-description`
const fields = [
  {
    name: 'slowlog-log-slower-than', zh: '慢命令阈值（µs）', en: 'Slow command threshold (µs)', min: -1,
    help: tr('阈值为 -1 时关闭记录，为 0 时记录所有命令。', 'A threshold of -1 disables logging and 0 logs every command.'),
    action: tr('应用阈值', 'Apply threshold'),
  },
  {
    name: 'slowlog-max-len', zh: '最大日志条数', en: 'Maximum log length', min: 0,
    help: tr('Redis 保留的慢日志条目上限。', 'Maximum number of slow log entries Redis retains.'),
    action: tr('应用日志长度', 'Apply log length'),
  },
]

function canSave(field) {
  const value = values[field.name]
  return !loading.value && !saving.value && !props.connection.readOnly && field.name in original &&
    Number.isSafeInteger(value) && value >= field.min && value !== original[field.name]
}

/** Read the current settings independently of whether slow log viewing is allowed. */
async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await call('SlowLogSettings', props.connection.id, props.tab.db, props.node)
    for (const { name } of fields) {
      if (!(name in data)) continue
      original[name] = values[name] = Number(data[name])
    }
    if (!fields.some(field => field.name in original)) error.value = tr('Redis 未返回慢日志设置。', 'Redis returned no slow log settings.')
  } catch (failure) {
    error.value = failure.message || String(failure)
  } finally {
    loading.value = false
  }
}

/** Write one setting so Redis versions accepting one CONFIG SET pair behave consistently. */
async function save(field) {
  if (!canSave(field)) return
  const value = values[field.name]
  saving.value = field.name
  try {
    await call('SetSlowLogSetting', props.connection.id, props.tab.db, props.node, field.name, value)
    original[field.name] = value
    lastSaved.value = field.name
    results[field.name] = { tone: 'success', text: tr('设置已应用', 'Setting applied') }
  } catch (failure) {
    results[field.name] = { tone: 'error', text: failure.message || String(failure) }
  } finally {
    saving.value = ''
  }
}

onMounted(load)
</script>

<template>
  <WorkspaceDialog :title-id="titleId" :description-id="descriptionId" :busy="Boolean(saving)" @close="emit('close')">
    <template #default="{ requestClose, closeDisabled }">
      <section class="modal" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId">
        <header class="modal-header">
          <h2 :id="titleId">{{ tr('慢日志设置', 'Slow log settings') }}</h2>
          <IconButton :icon="X" :label="tr('关闭', 'Close')" :disabled="closeDisabled" @click="requestClose" />
        </header>
        <div class="modal-body settings-body">
          <p :id="descriptionId" class="muted">
            {{ node ? `${node} · ` : '' }}{{ tr('设置立即对当前 Redis 节点生效。', 'Settings apply immediately on the selected Redis node.') }}
          </p>
          <StatusNotice v-if="connection.readOnly" tone="info" :text="tr('只读连接', 'Read-only connection')" />
          <StatusNotice v-if="loading" tone="info" :text="tr('正在读取设置…', 'Loading settings…')" />
          <StatusNotice v-else-if="error" tone="error" :text="error" retry @retry="load" />
          <template v-for="field in fields" :key="field.name">
            <form v-if="field.name in original" class="setting-section" :aria-labelledby="`${formId}-${field.name}-label`" @submit.prevent="save(field)">
              <label :id="`${formId}-${field.name}-label`" :for="`${formId}-${field.name}`">{{ tr(field.zh, field.en) }}</label>
              <p :id="`${formId}-${field.name}-help`" class="muted">{{ field.help }}</p>
              <div class="setting-controls">
                <input :id="`${formId}-${field.name}`" v-model.number="values[field.name]" type="number" :min="field.min"
                  :aria-describedby="`${formId}-${field.name}-help`" :readonly="connection.readOnly" :disabled="Boolean(saving) || loading"
                  required @input="delete results[field.name]">
                <NButton v-if="!connection.readOnly" size="small" attr-type="submit" :loading="saving === field.name"
                  :disabled="!canSave(field)" :aria-label="field.action">{{ tr('应用', 'Apply') }}</NButton>
              </div>
              <StatusNotice v-if="results[field.name]" :tone="results[field.name].tone" :text="results[field.name].text"
                :role="results[field.name].tone === 'error' ? 'alert' : lastSaved === field.name ? 'status' : 'group'" />
            </form>
          </template>
        </div>
      </section>
    </template>
  </WorkspaceDialog>
</template>

<style scoped>
.settings-body { display: grid; gap: 12px; overflow-wrap: anywhere; }
.setting-section { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 6px; }
.setting-section > label { font-size: 14px; font-weight: 650; }
.setting-controls { display: flex; flex-wrap: wrap; gap: 8px; }
.setting-controls input { flex: 0 1 120px; min-width: 0; }
</style>
