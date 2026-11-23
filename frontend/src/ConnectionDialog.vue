<script setup>
import { inject, reactive, ref, watch } from 'vue'
import { CircleAlert, CircleCheck, FolderOpen, X } from '@lucide/vue'
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
  const options = { ...draft }
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
  <div class="modal-backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
    <form class="modal connection-modal" aria-modal="true" role="dialog" @submit.prevent="save">
      <header class="modal-header">
        <h2>{{ editing ? tr('编辑连接', 'Edit connection') : tr('新建连接', 'New connection') }}</h2>
        <button type="button" class="flat icon" :aria-label="tr('关闭', 'Close')" @click="emit('close')"><X :size="19" /></button>
      </header>
      <div class="modal-body">
        <div class="form-grid">
          <label>{{ tr('连接名称', 'Connection name') }}<input v-model="draft.name" :placeholder="tr('例如 本地 Redis', 'e.g. Local Redis')" autofocus></label>
          <label>{{ tr('地址', 'Address') }}<input v-model.trim="draft.addr" required placeholder="127.0.0.1:6379" spellcheck="false"></label>
          <label>{{ tr('用户名', 'Username') }}<input v-model="draft.username" placeholder="default" autocomplete="off"></label>
          <label>{{ tr('密码', 'Password') }}<input v-model="draft.password" type="password" autocomplete="new-password"></label>
          <label>{{ tr('连接模式', 'Connection mode') }}<select v-model="draft.mode">
            <option value="standalone">{{ tr('单机', 'Standalone') }}</option><option value="cluster">Cluster</option><option value="sentinel">Sentinel</option>
          </select></label>
          <label>{{ tr('连接分组', 'Connection group') }}<select v-model="draft.groupId">
            <option value="">{{ tr('未分组', 'Ungrouped') }}</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
          </select></label>
          <label>{{ tr('树形分隔符', 'Tree separator') }}<input v-model="draft.separator" :placeholder="tr('留空时使用列表', 'Empty for flat list')"></label>
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
          <label>{{ tr('主节点名称', 'Master name') }}<input v-model="draft.sentinelMaster" required placeholder="mymaster"></label>
          <label>{{ tr('Sentinel 用户名', 'Sentinel username') }}<input v-model="draft.sentinelUsername"></label>
          <label>{{ tr('Sentinel 密码', 'Sentinel password') }}<input v-model="draft.sentinelPassword" type="password"></label>
        </fieldset>
        <fieldset v-if="draft.ssh" class="form-grid">
          <legend>SSH</legend>
          <label>{{ tr('SSH 地址', 'SSH address') }}<input v-model="draft.sshAddr" required placeholder="hostname:22"></label>
          <label>{{ tr('SSH 用户名', 'SSH username') }}<input v-model="draft.sshUsername" required></label>
          <label>{{ tr('SSH 密码', 'SSH password') }}<input v-model="draft.sshPassword" type="password"></label>
          <label>{{ tr('私钥口令', 'Key passphrase') }}<input v-model="draft.sshPassphrase" type="password"></label>
          <label v-for="[field, cn, en] in sshFiles" :key="field">{{ tr(cn, en) }}
            <span class="input-button"><input v-model="draft[field]" :placeholder="field === 'sshKnownHosts' ? '~/.ssh/known_hosts' : ''">
              <button type="button" class="icon" :title="tr(cn, en)" @click="pick(field, tr(cn, en))"><FolderOpen :size="16" /></button>
            </span>
          </label>
          <label>{{ tr('握手超时（秒）', 'Handshake timeout (s)') }}<input v-model.number="draft.sshTimeout" type="number" min="1"></label>
        </fieldset>
        <fieldset v-if="draft.tls" class="form-grid">
          <legend>TLS/SSL</legend>
          <label v-for="[field, cn, en] in files" :key="field">{{ tr(cn, en) }}
            <span class="input-button"><input v-model="draft[field]">
              <button type="button" class="icon" :title="tr(cn, en)" @click="pick(field, tr(cn, en))"><FolderOpen :size="16" /></button>
            </span>
          </label>
          <label>SNI<input v-model="draft.tlsServerName"></label>
        </fieldset>
      </div>
      <div v-if="result" class="notice connection-result" :class="result.success ? 'success' : 'error'" role="status">
        <CircleCheck v-if="result.success" :size="21" aria-hidden="true" />
        <CircleAlert v-else :size="21" aria-hidden="true" />
        <div>
          <strong>{{ result.success ? tr('连接成功', 'Connection successful') : tr('连接失败', 'Connection failed') }}</strong>
          <p>{{ result.detail }}</p>
        </div>
      </div>
      <footer class="modal-footer">
        <button type="button" :disabled="busy" @click="verify">{{ busy ? tr('正在测试…', 'Testing…') : tr('测试连接', 'Test connection') }}</button>
        <span class="spacer"></span>
        <button type="button" @click="emit('close')">{{ tr('取消', 'Cancel') }}</button>
        <button class="primary" type="submit">{{ tr('保存连接', 'Save connection') }}</button>
      </footer>
    </form>
  </div>
</template>
