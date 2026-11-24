<script setup>
import { inject, onMounted, reactive, ref } from 'vue'
import { X } from '@lucide/vue'
import { call } from './api.js'

const props = defineProps({ tab: Object, connection: Object, node: String })
const emit = defineEmits(['close'])
const tr = inject('tr')
const values = reactive({})
const original = reactive({})
const loading = ref(true)
const saving = ref('')
const error = ref('')
const feedback = ref('')
const fields = [
  { name: 'slowlog-log-slower-than', zh: '慢命令阈值（µs）', en: 'Slow command threshold (µs)', min: -1 },
  { name: 'slowlog-max-len', zh: '最大日志条数', en: 'Maximum log length', min: 0 },
]

/** Read the current settings independently of whether slow log viewing is allowed. */
async function load() {
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
  const value = values[field.name]
  if (saving.value || props.connection.readOnly || !Number.isSafeInteger(value) || value < field.min) return
  saving.value = field.name
  error.value = feedback.value = ''
  try {
    await call('SetSlowLogSetting', props.connection.id, props.tab.db, props.node, field.name, value)
    original[field.name] = value
    feedback.value = tr('设置已应用', 'Setting applied')
  } catch (failure) {
    error.value = failure.message || String(failure)
  } finally {
    saving.value = ''
  }
}

onMounted(load)
</script>

<template>
  <WorkspaceDialog @close="emit('close')">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="slowlog-settings-title">
      <header class="modal-header">
        <h2 id="slowlog-settings-title">{{ tr('慢日志设置', 'Slow log settings') }}</h2>
        <NButton size="small" quaternary class="icon" :aria-label="tr('关闭', 'Close')" @click="emit('close')"><X :size="19" /></NButton>
      </header>
      <div class="modal-body">
        <p v-if="node" class="muted">{{ node }}</p>
        <p v-if="loading" class="muted">{{ tr('正在读取设置…', 'Loading settings…') }}</p>
        <NAlert v-if="error" type="error">{{ error }}</NAlert>
        <p v-if="feedback" role="status" class="notice success">{{ feedback }}</p>
        <template v-for="field in fields" :key="field.name">
          <form v-if="field.name in original" class="setting-row" @submit.prevent="save(field)">
            <label :for="'redis-' + field.name">{{ tr(field.zh, field.en) }}</label>
            <input :id="'redis-' + field.name" v-model.number="values[field.name]" type="number"
              :min="field.min" :readonly="connection.readOnly" :disabled="Boolean(saving)" required>
            <NButton v-if="!connection.readOnly" size="small" attr-type="submit" :loading="saving === field.name"
              :disabled="Boolean(saving) || values[field.name] === original[field.name]"
              :aria-label="field.min === -1 ? tr('应用阈值', 'Apply threshold') : tr('应用日志长度', 'Apply log length')">
              {{ tr('应用', 'Apply') }}
            </NButton>
          </form>
        </template>
        <p v-if="!loading && fields[0].name in original" class="muted">
          {{ tr('阈值为 -1 时关闭记录，为 0 时记录所有命令。设置立即对当前 Redis 节点生效。', 'A threshold of -1 disables logging and 0 logs every command. Settings apply immediately on the selected Redis node.') }}
        </p>
      </div>
    </section>
  </WorkspaceDialog>
</template>

<style scoped>
.setting-row { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(65px, 120px) auto; align-items: center; gap: 8px; }
.setting-row input { width: 100%; }
</style>
