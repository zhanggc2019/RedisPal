<script setup>
import { inject, reactive, ref, watch } from 'vue'
import { FolderOpen, X } from '@lucide/vue'
import { call, selectFile } from './api.js'

const props = defineProps({ initial: Object, groups: Array, editing: Boolean })
const emit = defineEmits(['close', 'save'])
const tr = inject('tr')
const draft = reactive({ ...props.initial })
const result = ref(null)
const busy = ref(false)
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
})

/** Pick a file on the host so Go can read its actual absolute path. */
async function pick(field, label) {
  const path = await selectFile(label)
  if (path) draft[field] = path
}

/** Ping Redis with the current form values and report connection/authentication failures. */
async function verify() {
  const revision = draftRevision
  const options = { ...draft, addr: draft.addr.trim() }
  busy.value = true
  result.value = null
  try {
    await call('Test', options)
    if (revision === draftRevision) result.value = { success: true, detail: options.addr }
  } catch (error) {
    if (revision === draftRevision) result.value = { success: false, detail: error.message || String(error) }
  } finally {
    busy.value = false
  }
}

/** Submit the editable connection while leaving its persistent ID unchanged. */
function save() {
  emit('save', { ...draft, addr: draft.addr.trim(), name: draft.name.trim() || draft.addr.trim() })
}
</script>

<template>
  <WorkspaceDialog @close="emit('close')">
    <form class="modal connection-modal" aria-modal="true" aria-labelledby="connection-title" role="dialog" @submit.prevent="save">
      <header class="modal-header">
        <h2 id="connection-title">{{ editing ? tr('编辑连接', 'Edit connection') : tr('新建连接', 'New connection') }}</h2>
        <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭', 'Close')" @click="emit('close')"><X :size="19" /></NButton>
      </header>
      <div class="modal-body">
        <div class="form-grid">
          <label><span id="connection-name-label">{{ tr('连接名称', 'Connection name') }}</span>
            <NInput v-model:value="draft.name" :placeholder="tr('例如 本地 Redis', 'e.g. Local Redis')" :input-props="{ 'aria-labelledby': 'connection-name-label' }" autofocus /></label>
          <label><span id="connection-address-label">{{ tr('地址', 'Address') }}</span>
            <NInput v-model:value="draft.addr" placeholder="127.0.0.1:6379" :input-props="{ 'aria-labelledby': 'connection-address-label', required: true, spellcheck: false }" /></label>
          <label><span id="connection-username-label">{{ tr('用户名', 'Username') }}</span>
            <NInput v-model:value="draft.username" placeholder="default" :input-props="{ 'aria-labelledby': 'connection-username-label', autocomplete: 'off' }" /></label>
          <label><span id="connection-password-label">{{ tr('密码', 'Password') }}</span>
            <NInput v-model:value="draft.password" type="password" placeholder="" :input-props="{ 'aria-labelledby': 'connection-password-label', autocomplete: 'new-password' }" /></label>
          <label>{{ tr('连接模式', 'Connection mode') }}<select v-model="draft.mode">
            <option value="standalone">{{ tr('单机', 'Standalone') }}</option><option value="cluster">Cluster</option><option value="sentinel">Sentinel</option>
          </select></label>
          <label>{{ tr('连接分组', 'Connection group') }}<select v-model="draft.groupId">
            <option value="">{{ tr('未分组', 'Ungrouped') }}</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
          </select></label>
          <label><span id="connection-separator-label">{{ tr('树形分隔符', 'Tree separator') }}</span>
            <NInput v-model:value="draft.separator" :placeholder="tr('留空时使用列表', 'Empty for flat list')" :input-props="{ 'aria-labelledby': 'connection-separator-label' }" /></label>
          <label>{{ tr('连接颜色', 'Connection color') }}<select v-model="draft.color">
            <option value="">{{ tr('默认', 'Default') }}</option><option value="#e34f48">{{ tr('红色', 'Red') }}</option>
            <option value="#da970c">{{ tr('橙色', 'Orange') }}</option><option value="#28a969">{{ tr('绿色', 'Green') }}</option><option value="#3888dc">{{ tr('蓝色', 'Blue') }}</option><option value="#8a68cb">{{ tr('紫色', 'Purple') }}</option>
          </select></label>
        </div>
        <p v-if="draft.mode !== 'standalone'" class="muted">{{ tr('多个节点地址可用逗号隔开。', 'Separate multiple addresses with commas.') }}</p>
        <div class="checks">
          <label><input v-model="draft.ssh" type="checkbox"> SSH</label>
          <label><input v-model="draft.tls" type="checkbox"> TLS/SSL</label>
          <label><input v-model="draft.readOnly" type="checkbox"> {{ tr('只读', 'Read-only') }}</label>
        </div>
        <fieldset v-if="draft.mode === 'sentinel'" class="form-grid">
          <legend>Sentinel</legend>
          <label>{{ tr('主节点名称', 'Master name') }}<NInput v-model:value="draft.sentinelMaster" placeholder="mymaster" :input-props="{ required: true }" /></label>
          <label>{{ tr('Sentinel 用户名', 'Sentinel username') }}<NInput v-model:value="draft.sentinelUsername" /></label>
          <label>{{ tr('Sentinel 密码', 'Sentinel password') }}<NInput v-model:value="draft.sentinelPassword" type="password" /></label>
        </fieldset>
        <fieldset v-if="draft.ssh" class="form-grid">
          <legend>SSH</legend>
          <label>{{ tr('SSH 地址', 'SSH address') }}<NInput v-model:value="draft.sshAddr" placeholder="hostname:22" :input-props="{ required: true }" /></label>
          <label>{{ tr('SSH 用户名', 'SSH username') }}<NInput v-model:value="draft.sshUsername" :input-props="{ required: true }" /></label>
          <label>{{ tr('SSH 密码', 'SSH password') }}<NInput v-model:value="draft.sshPassword" type="password" /></label>
          <label>{{ tr('私钥口令', 'Key passphrase') }}<NInput v-model:value="draft.sshPassphrase" type="password" /></label>
          <label v-for="[field, cn, en] in sshFiles" :key="field">{{ tr(cn, en) }}
            <span class="input-button"><NInput v-model:value="draft[field]" :placeholder="field === 'sshKnownHosts' ? '~/.ssh/known_hosts' : ''" />
              <NButton size="small" class="icon" :title="tr(cn, en)" @click="pick(field, tr(cn, en))"><FolderOpen :size="16" /></NButton>
            </span>
          </label>
          <label>{{ tr('握手超时（秒）', 'Handshake timeout (s)') }}<input v-model.number="draft.sshTimeout" type="number" min="1"></label>
        </fieldset>
        <fieldset v-if="draft.tls" class="form-grid">
          <legend>TLS/SSL</legend>
          <label v-for="[field, cn, en] in files" :key="field">{{ tr(cn, en) }}
            <span class="input-button"><NInput v-model:value="draft[field]" />
              <NButton size="small" class="icon" :title="tr(cn, en)" @click="pick(field, tr(cn, en))"><FolderOpen :size="16" /></NButton>
            </span>
          </label>
          <label>SNI<NInput v-model:value="draft.tlsServerName" /></label>
        </fieldset>
      </div>
      <NAlert v-if="result" class="connection-result" :class="{ success: result.success }" :type="result.success ? 'success' : 'error'"
        :title="result.success ? tr('连接成功', 'Connection successful') : tr('连接失败', 'Connection failed')">
        {{ result.detail }}
      </NAlert>
      <footer class="modal-footer">
        <NButton size="small" :loading="busy" @click="verify">{{ busy ? tr('正在测试…', 'Testing…') : tr('测试连接', 'Test connection') }}</NButton>
        <span class="spacer"></span>
        <NButton size="small" @click="emit('close')">{{ tr('取消', 'Cancel') }}</NButton>
        <NButton size="small" type="primary" attr-type="submit" class="primary">{{ tr('保存连接', 'Save connection') }}</NButton>
      </footer>
    </form>
  </WorkspaceDialog>
</template>
