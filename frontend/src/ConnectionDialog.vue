<script setup>
import { computed, defineComponent, inject, reactive, ref, watch } from 'vue'
import { ChevronDown, FolderOpen, X } from '@lucide/vue'
import { call, selectFile } from './api.js'

// Give the form its own render effect so draft updates do not rerender the Naive UI modal slot.
const ConnectionForm = defineComponent({
  setup(_, { slots }) {
    return () => slots.default()
  },
})

const props = defineProps({ initial: Object, groups: Array, editing: Boolean })
const emit = defineEmits(['close', 'save'])
const tr = inject('tr')
const draft = reactive({ ...props.initial })
const result = ref(null)
const busy = ref(false)
const testLabel = computed(() => busy.value ? tr('正在测试…', 'Testing…') : tr('测试连接', 'Test connection'))
const advancedOpen = ref(false)
let draftRevision = 0
const files = [
  ['tlsCA', 'CA 证书', 'CA certificate'],
  ['tlsCert', '客户端证书', 'Client certificate'],
  ['tlsKey', '客户端私钥', 'Client key'],
]
const sshFiles = [['sshKey', 'SSH 私钥', 'SSH private key'], ['sshKnownHosts', '主机密钥文件', 'Known hosts file']]

/** Invalidate test results when the displayed form no longer matches the tested form. */
watch(draft, () => {
  draftRevision++
  result.value = null
}, { flush: 'sync' })

/** Pick a file on the host so Go can read its actual absolute path. */
async function pick(field, label) {
  const path = await selectFile(label)
  if (path) draft[field] = path
}

/** Ping Redis with the current form values and report connection/authentication failures. */
async function verify() {
  if (busy.value) return
  const revision = draftRevision
  const options = { ...draft, addr: draft.addr.trim() }
  busy.value = true
  result.value = null
  const startedAt = performance.now()
  let outcome
  try {
    await call('Test', options)
    outcome = { success: true, detail: options.addr }
  } catch (error) {
    outcome = { success: false, detail: error?.message || String(error) }
  } finally {
    if (revision === draftRevision) {
      result.value = { ...outcome, elapsedMs: Math.round(performance.now() - startedAt) }
    }
    busy.value = false
  }
}

/** Submit the editable connection while leaving its persistent ID unchanged. */
function save() {
  if (busy.value) return
  emit('save', { ...draft, addr: draft.addr.trim(), name: draft.name.trim() || draft.addr.trim() })
}
</script>

<template>
  <WorkspaceDialog title-id="connection-title" :busy="busy" @close="emit('close')">
    <template #default="{ requestClose, closeDisabled }">
      <ConnectionForm>
      <form class="modal connection-modal" aria-modal="true" aria-labelledby="connection-title" role="dialog" @submit.prevent="save">
        <header class="modal-header">
          <h2 id="connection-title">{{ editing ? tr('编辑连接', 'Edit connection') : tr('新建连接', 'New connection') }}</h2>
          <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭', 'Close')" :disabled="closeDisabled" @click="requestClose"><X :size="19" aria-hidden="true" /></NButton>
        </header>
        <div class="modal-body connection-body">
          <fieldset class="connection-section form-grid">
            <legend>{{ tr('常规', 'General') }}</legend>
            <label><span id="connection-name-label">{{ tr('连接名称', 'Connection name') }}</span>
              <NInput v-model:value="draft.name" size="small" :placeholder="tr('例如 本地 Redis', 'e.g. Local Redis')" :input-props="{ 'aria-labelledby': 'connection-name-label' }" autofocus />
            </label>
            <label><span id="connection-address-label">{{ tr('地址', 'Address') }}</span>
              <NInput v-model:value="draft.addr" size="small" placeholder="127.0.0.1:6379" :input-props="{
                'aria-labelledby': 'connection-address-label',
                'aria-describedby': draft.mode !== 'standalone' ? 'connection-address-hint' : undefined,
                required: true,
                spellcheck: false,
              }" />
              <span v-if="draft.mode !== 'standalone'" id="connection-address-hint" class="connection-hint">
                {{ tr('多个节点地址可用逗号隔开。', 'Separate multiple addresses with commas.') }}
              </span>
            </label>
            <label><span id="connection-mode-label">{{ tr('连接模式', 'Connection mode') }}</span>
              <select v-model="draft.mode" aria-labelledby="connection-mode-label">
                <option value="standalone">{{ tr('单机', 'Standalone') }}</option>
                <option value="cluster">Cluster</option>
                <option value="sentinel">Sentinel</option>
              </select>
            </label>
            <label><span id="connection-group-label">{{ tr('连接分组', 'Connection group') }}</span>
              <select v-model="draft.groupId" aria-labelledby="connection-group-label">
                <option value="">{{ tr('未分组', 'Ungrouped') }}</option>
                <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
              </select>
            </label>
            <label class="check-label"><input v-model="draft.readOnly" type="checkbox"> {{ tr('只读', 'Read-only') }}</label>
          </fieldset>

          <fieldset class="connection-section form-grid">
            <legend>{{ tr('认证', 'Authentication') }}</legend>
            <label><span id="connection-username-label">{{ tr('用户名', 'Username') }}</span>
              <NInput v-model:value="draft.username" size="small" placeholder="default" :input-props="{ 'aria-labelledby': 'connection-username-label', autocomplete: 'off' }" />
            </label>
            <label><span id="connection-password-label">{{ tr('密码', 'Password') }}</span>
              <NInput v-model:value="draft.password" size="small" type="password" placeholder="" :input-props="{ 'aria-labelledby': 'connection-password-label', autocomplete: 'new-password' }" />
            </label>
          </fieldset>

          <fieldset class="connection-section">
            <legend>{{ tr('传输', 'Transport') }}</legend>
            <div class="checks connection-transport">
              <label><input v-model="draft.ssh" type="checkbox" aria-controls="connection-ssh"> SSH</label>
              <label><input v-model="draft.tls" type="checkbox" aria-controls="connection-tls"> TLS/SSL</label>
            </div>
            <fieldset v-show="draft.ssh" id="connection-ssh" class="connection-subsection form-grid" :disabled="!draft.ssh">
              <legend>SSH</legend>
              <label><span id="connection-ssh-address-label">{{ tr('SSH 地址', 'SSH address') }}</span>
                <NInput v-model:value="draft.sshAddr" size="small" placeholder="hostname:22" :input-props="{ 'aria-labelledby': 'connection-ssh-address-label', required: true }" />
              </label>
              <label><span id="connection-ssh-username-label">{{ tr('SSH 用户名', 'SSH username') }}</span>
                <NInput v-model:value="draft.sshUsername" size="small" :input-props="{ 'aria-labelledby': 'connection-ssh-username-label', required: true }" />
              </label>
              <label><span id="connection-ssh-password-label">{{ tr('SSH 密码', 'SSH password') }}</span>
                <NInput v-model:value="draft.sshPassword" size="small" type="password" :input-props="{ 'aria-labelledby': 'connection-ssh-password-label' }" />
              </label>
              <label><span id="connection-ssh-passphrase-label">{{ tr('私钥口令', 'Key passphrase') }}</span>
                <NInput v-model:value="draft.sshPassphrase" size="small" type="password" :input-props="{ 'aria-labelledby': 'connection-ssh-passphrase-label' }" />
              </label>
              <div v-for="[field, cn, en] in sshFiles" :key="field" class="connection-file">
                <label :for="`connection-${field}`">{{ tr(cn, en) }}</label>
                <div class="input-button">
                  <NInput v-model:value="draft[field]" size="small" :input-props="{ id: `connection-${field}` }" :placeholder="field === 'sshKnownHosts' ? '~/.ssh/known_hosts' : ''" />
                  <NButton size="small" class="icon" :title="tr(cn, en)" :aria-label="tr(`选择${cn}`, `Browse for ${en}`)" @click="pick(field, tr(cn, en))"><FolderOpen :size="16" aria-hidden="true" /></NButton>
                </div>
              </div>
              <label>{{ tr('握手超时（秒）', 'Handshake timeout (s)') }}<input v-model.number="draft.sshTimeout" type="number" min="1"></label>
            </fieldset>
            <fieldset v-show="draft.tls" id="connection-tls" class="connection-subsection form-grid" :disabled="!draft.tls">
              <legend>TLS/SSL</legend>
              <div v-for="[field, cn, en] in files" :key="field" class="connection-file">
                <label :for="`connection-${field}`">{{ tr(cn, en) }}</label>
                <div class="input-button">
                  <NInput v-model:value="draft[field]" size="small" :input-props="{ id: `connection-${field}` }" />
                  <NButton size="small" class="icon" :title="tr(cn, en)" :aria-label="tr(`选择${cn}`, `Browse for ${en}`)" @click="pick(field, tr(cn, en))"><FolderOpen :size="16" aria-hidden="true" /></NButton>
                </div>
              </div>
              <label><span id="connection-tls-sni-label">SNI</span>
                <NInput v-model:value="draft.tlsServerName" size="small" :input-props="{ 'aria-labelledby': 'connection-tls-sni-label' }" />
              </label>
            </fieldset>
          </fieldset>

          <div class="connection-section connection-advanced">
            <NButton size="small" quaternary class="connection-disclosure" :aria-expanded="advancedOpen" aria-controls="connection-advanced-options" @click="advancedOpen = !advancedOpen">
              <template #icon><ChevronDown :size="16" aria-hidden="true" /></template>
              {{ tr('高级选项', 'Advanced options') }}
            </NButton>
            <div v-show="advancedOpen" id="connection-advanced-options" class="form-grid connection-options">
              <label><span id="connection-separator-label">{{ tr('树形分隔符', 'Tree separator') }}</span>
                <NInput v-model:value="draft.separator" size="small" :placeholder="tr('留空时使用列表', 'Empty for flat list')" :input-props="{ 'aria-labelledby': 'connection-separator-label' }" />
              </label>
              <label><span id="connection-color-label">{{ tr('连接颜色', 'Connection color') }}</span>
                <select v-model="draft.color" aria-labelledby="connection-color-label">
                  <option value="">{{ tr('默认', 'Default') }}</option><option value="#e34f48">{{ tr('红色', 'Red') }}</option>
                  <option value="#da970c">{{ tr('橙色', 'Orange') }}</option><option value="#28a969">{{ tr('绿色', 'Green') }}</option>
                  <option value="#3888dc">{{ tr('蓝色', 'Blue') }}</option><option value="#8a68cb">{{ tr('紫色', 'Purple') }}</option>
                </select>
              </label>
            </div>
            <fieldset v-show="draft.mode === 'sentinel'" class="connection-subsection form-grid" :disabled="draft.mode !== 'sentinel'">
              <legend>Sentinel</legend>
              <label><span id="connection-sentinel-master-label">{{ tr('主节点名称', 'Master name') }}</span>
                <NInput v-model:value="draft.sentinelMaster" size="small" placeholder="mymaster" :input-props="{ 'aria-labelledby': 'connection-sentinel-master-label', required: true }" />
              </label>
              <label><span id="connection-sentinel-username-label">{{ tr('Sentinel 用户名', 'Sentinel username') }}</span>
                <NInput v-model:value="draft.sentinelUsername" size="small" :input-props="{ 'aria-labelledby': 'connection-sentinel-username-label' }" />
              </label>
              <label><span id="connection-sentinel-password-label">{{ tr('Sentinel 密码', 'Sentinel password') }}</span>
                <NInput v-model:value="draft.sentinelPassword" size="small" type="password" :input-props="{ 'aria-labelledby': 'connection-sentinel-password-label' }" />
              </label>
            </fieldset>
          </div>
        </div>
        <NAlert v-if="result" class="connection-result" :class="{ success: result.success }" :type="result.success ? 'success' : 'error'"
          :title="result.success ? tr('连接成功', 'Connection successful') : tr('连接失败', 'Connection failed')">
          <div class="connection-detail">{{ result.detail }}</div>
          <div class="connection-elapsed">{{ tr(`耗时 ${result.elapsedMs} 毫秒`, `Elapsed ${result.elapsedMs} ms`) }}</div>
        </NAlert>
        <footer class="modal-footer connection-footer">
          <NButton size="small" :loading="busy" :aria-label="testLabel" :aria-disabled="busy || undefined" @click="verify">{{ testLabel }}</NButton>
          <span class="spacer"></span>
          <NButton size="small" :disabled="closeDisabled" @click="requestClose">{{ tr('取消', 'Cancel') }}</NButton>
          <NButton size="small" type="primary" attr-type="submit" class="primary" :disabled="busy">{{ tr('保存连接', 'Save connection') }}</NButton>
        </footer>
      </form>
      </ConnectionForm>
    </template>
  </WorkspaceDialog>
</template>

<style scoped>
.connection-body {
  container-type: inline-size;
}

.connection-section,
.connection-subsection {
  min-inline-size: 0;
  padding: 8px 12px 10px;
}

.connection-section > legend,
.connection-subsection > legend {
  color: var(--ink);
  font-size: 13px;
  font-weight: 650;
}

.connection-subsection {
  margin-block-start: 8px;
}

.form-grid {
  gap: 8px 12px;
}

.form-grid > label,
.connection-file {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-inline-size: 0;
  color: var(--muted);
  font-size: 13px;
}

.form-grid > .check-label {
  flex-direction: row;
}

.form-grid select,
.form-grid input[type='number'] {
  min-inline-size: 0;
  width: 100%;
}

.connection-hint {
  font-size: 12px;
}

.connection-transport,
.connection-footer {
  flex-wrap: wrap;
}

.connection-advanced {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding-block: 5px;
}

.connection-disclosure {
  margin-inline-start: -6px;
  font-weight: 650;
}

.connection-disclosure[aria-expanded='false'] :deep(svg) {
  transform: rotate(-90deg);
}

.connection-options {
  padding-block: 4px 5px;
}

.connection-advanced > .connection-subsection {
  margin-block: 4px;
}

.connection-detail {
  white-space: pre-wrap;
}

.connection-elapsed {
  margin-block-start: 4px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

@container (max-width: 420px) {
  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
