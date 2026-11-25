<script setup>
import { computed, inject, onMounted, ref, useId } from 'vue'
import { Plus, RefreshCw, Trash2, X } from '@lucide/vue'
import { display, identity } from './model.js'
import { streamPage, streamRecords } from './streamdata.js'
import { nextTabIndex } from './tabs.js'
import EmptyState from './components/EmptyState.vue'
import IconButton from './components/IconButton.vue'
import StatusNotice from './components/StatusNotice.vue'

const props = defineProps({ streamKey: [String, Object], run: Function, readOnly: Boolean })
const tr = inject('tr')
const notify = inject('notify')
const ask = inject('ask')
const groups = ref([])
const selected = ref(null)
const group = computed(() => groups.value.find(item => item.id === selected.value))
const consumers = ref([])
const pending = ref([])
const pendingCursor = ref(null)
const busy = ref(false)
const error = ref('')
const consumerError = ref('')
const pendingError = ref('')
const dialog = ref(null)
const scopeId = useId()
const titleId = `${scopeId}-title`
const views = computed(() => [
  { id: 'groups', label: tr('组', 'Groups') },
  { id: 'consumers', label: tr('消费者', 'Consumers') },
  { id: 'pending', label: tr('待处理', 'Pending') },
])
const view = ref('groups')
const pageSize = 50

/** Activate and focus the next peer tab using the same keys as the workspace tabs. */
function navigateViews(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const tabs = views.value
  const current = tabs.findIndex(item => item.id === view.value)
  const next = nextTabIndex(current, tabs.length, event.key)
  view.value = tabs[next].id
  event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus()
}

/** Serialize requests so refreshes and mutations cannot act on different selections. */
async function withBusy(action) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (failure) {
    error.value = failure.message
  } finally {
    busy.value = false
  }
}

/** Read an inclusive slice of pending entries with one lookahead row. */
async function pendingPage(groupName, cursor = '-') {
  const reply = await props.run('XPENDING', props.streamKey, groupName, cursor, '+', pageSize + 1)
  return streamPage(reply, pageSize)
}

/** Fetch the selected group's consumer list and pending entries independently. */
async function loadGroup() {
  consumers.value = []
  pending.value = []
  pendingCursor.value = null
  consumerError.value = ''
  pendingError.value = ''
  if (!group.value) return
  const name = group.value.name
  const [people, messages] = await Promise.allSettled([
    props.run('XINFO', 'CONSUMERS', props.streamKey, name),
    pendingPage(name),
  ])
  if (people.status === 'fulfilled') consumers.value = streamRecords(people.value)
  else consumerError.value = people.reason.message
  if (messages.status === 'fulfilled') {
    pending.value = messages.value.entries
    pendingCursor.value = messages.value.cursor
  } else pendingError.value = messages.reason.message
}

/** Reload group summaries and keep the selected name if it still exists. */
async function loadGroups() {
  groups.value = streamRecords(await props.run('XINFO', 'GROUPS', props.streamKey))
  if (!group.value) selected.value = groups.value[0]?.id ?? null
  await loadGroup()
}

/** Open a group using its exact Redis name, including binary names. */
function selectGroup(id) {
  return withBusy(() => {
    selected.value = id
    return loadGroup()
  })
}

/** Append the next page of pending IDs from the selected group. */
function loadMore() {
  return withBusy(async () => {
    if (!group.value || pendingCursor.value === null) return
    const page = await pendingPage(group.value.name, pendingCursor.value)
    pending.value.push(...page.entries)
    pendingCursor.value = page.cursor
  })
}

/** Prepare the creation form with Redis's tail cursor as the default. */
function createGroup() {
  if (busy.value || props.readOnly) return
  error.value = ''
  dialog.value = { kind: 'create', name: '', start: '$' }
}

/** Prepare a claim for an existing pending ID without changing Redis yet. */
function claimEntry(id) {
  if (busy.value || props.readOnly || !group.value) return
  error.value = ''
  dialog.value = { kind: 'claim', id, target: '', consumer: '', minIdle: 0 }
}

/** Close an editable dialog after its in-flight operation has finished. */
function closeDialog() {
  if (busy.value) return
  dialog.value = null
  error.value = ''
}

/** Create the consumer group or transfer a pending entry to the chosen consumer. */
function saveDialog() {
  return withBusy(async () => {
    if (props.readOnly || !dialog.value) return
    const form = dialog.value
    if (form.kind === 'create') {
      if (!form.name.length) throw new Error(tr('请输入组名。', 'Enter a group name.'))
      await props.run('XGROUP', 'CREATE', props.streamKey, form.name, form.start)
      selected.value = identity(form.name)
      notify(tr('消费组已创建', 'Consumer group created'))
    } else {
      const destination = form.target ? consumers.value.find(item => item.id === form.target)?.name : form.consumer
      if (!group.value || destination == null || (!form.target && destination === '')) throw new Error(tr('请选择或输入目标消费者。', 'Select or enter a target consumer.'))
      if (!Number.isSafeInteger(form.minIdle) || form.minIdle < 0) throw new Error(tr('最小空闲时间必须为非负整数。', 'Minimum idle time must be a non-negative integer.'))
      const claimed = await props.run('XCLAIM', props.streamKey, group.value.name, destination, form.minIdle, form.id, 'JUSTID')
      if (claimed.length) notify(tr('消息已认领', 'Entry claimed'))
      else notify(tr('消息未认领，可能已处理或未达到最小空闲时间。', 'Entry was not claimed. It may have been processed or below the minimum idle time.'), true)
    }
    dialog.value = null
    await loadGroups()
  })
}

/** Acknowledge a pending ID without deleting the underlying Stream entry. */
function acknowledge(id) {
  return withBusy(async () => {
    if (props.readOnly || !group.value) return
    const acknowledged = await props.run('XACK', props.streamKey, group.value.name, id)
    if (acknowledged) notify(tr('消息已确认', 'Entry acknowledged'))
    else notify(tr('该消息已不在待处理列表。', 'This entry is no longer pending.'), true)
    await loadGroups()
  })
}

/** Delete a consumer group after confirmation of its pending-list removal. */
function deleteGroup(item) {
  return withBusy(async () => {
    if (props.readOnly) return
    const confirmed = await ask({
      title: tr('删除消费组', 'Delete consumer group'),
      text: display(item.name) + '\n' + tr('这将移除该组及其待处理记录，Stream 消息会保留。', 'This removes the group and its pending records. Stream entries remain.'),
      danger: true,
    })
    if (!confirmed || props.readOnly) return
    await props.run('XGROUP', 'DESTROY', props.streamKey, item.name)
    await loadGroups()
  })
}

onMounted(() => withBusy(loadGroups))
</script>

<template>
  <section class="stream-groups" :aria-label="tr('消费组', 'Consumer groups')">
    <div class="row-tools">
      <h2>{{ tr('消费组', 'Consumer groups') }}</h2><span class="spacer"></span>
      <NButton size="small" :disabled="busy" @click="withBusy(loadGroups)"><RefreshCw :size="15" aria-hidden="true" />{{ tr('刷新消费组', 'Refresh consumer groups') }}</NButton>
      <NButton v-if="!readOnly" size="small" type="primary" :disabled="busy" @click="createGroup"><Plus :size="15" aria-hidden="true" />{{ tr('创建消费组', 'Create group') }}</NButton>
    </div>
    <StatusNotice v-if="readOnly" tone="info" :title="tr('只读连接', 'Read-only connection')" />
    <StatusNotice v-if="error && !dialog" tone="error" :text="error" />
    <div class="stream-tabs" role="tablist" :aria-label="tr('消费组视图', 'Consumer group views')" @keydown="navigateViews">
      <button v-for="item in views" :id="`${scopeId}-tab-${item.id}`" :key="item.id" type="button" role="tab"
        :aria-controls="`${scopeId}-panel-${item.id}`" :aria-selected="view === item.id"
        :tabindex="view === item.id ? 0 : -1" @click="view = item.id">{{ item.label }}</button>
    </div>
    <div v-for="item in views" v-show="view === item.id" :id="`${scopeId}-panel-${item.id}`" :key="item.id" class="stream-view"
      role="tabpanel" :aria-labelledby="`${scopeId}-tab-${item.id}`" :aria-busy="busy" tabindex="0">
      <template v-if="view === item.id">
        <StatusNotice v-if="busy" tone="info" :text="tr('处理中…', 'Working…')" />
        <template v-if="view === 'groups'">
          <EmptyState v-if="!groups.length && !busy && !error" compact>{{ tr('没有消费组', 'No consumer groups') }}</EmptyState>
          <div v-if="groups.length" class="table-wrap">
            <NTable size="small" :bordered="false" class="data-table">
              <thead><tr>
                <th>{{ tr('组名', 'Group name') }}</th><th>{{ tr('消费者', 'Consumers') }}</th><th>{{ tr('待处理', 'Pending') }}</th>
                <th>{{ tr('未投递', 'Lag') }}</th><th>{{ tr('最后投递 ID', 'Last delivered ID') }}</th><th v-if="!readOnly">{{ tr('操作', 'Actions') }}</th>
              </tr></thead>
              <tbody>
                <tr v-for="item in groups" :key="item.id">
                  <td><NButton size="small" :type="item.id === selected ? 'primary' : 'default'" :aria-pressed="item.id === selected" :disabled="busy" @click="selectGroup(item.id)">{{ display(item.name) || '␀' }}</NButton></td>
                  <td>{{ item.consumers }}</td><td>{{ item.pending }}</td><td>{{ item.lag ?? '—' }}</td>
                  <td class="mono">{{ item['last-delivered-id'] ?? '—' }}</td>
                  <td v-if="!readOnly" class="row-ops"><IconButton :icon="Trash2" danger :disabled="busy"
                    :label="tr('删除组', 'Delete group') + ' ' + (display(item.name) || '␀')" @click="deleteGroup(item)" /></td>
                </tr>
              </tbody>
            </NTable>
          </div>
        </template>
        <EmptyState v-else-if="!group && !busy && !error" compact>{{ tr('请先在“组”中选择一个消费组。', 'Select a consumer group on the Groups tab first.') }}</EmptyState>
        <template v-else-if="group && view === 'consumers'">
          <h2>{{ tr('消费者', 'Consumers') }} · {{ display(group.name) || '␀' }}</h2>
          <StatusNotice v-if="consumerError" tone="error" :text="consumerError" :retry="!busy" @retry="withBusy(loadGroup)" />
          <EmptyState v-else-if="!consumers.length && !busy" compact>{{ tr('没有消费者', 'No consumers') }}</EmptyState>
          <div v-if="consumers.length" class="table-wrap">
            <NTable size="small" :bordered="false" class="data-table">
              <thead><tr><th>{{ tr('消费者名称', 'Consumer name') }}</th><th>{{ tr('待处理', 'Pending') }}</th><th>{{ tr('空闲时间（毫秒）', 'Idle (ms)') }}</th></tr></thead>
              <tbody>
                <tr v-for="item in consumers" :key="item.id"><td class="mono">{{ display(item.name) || '␀' }}</td><td>{{ item.pending }}</td><td>{{ item.idle }}</td></tr>
              </tbody>
            </NTable>
          </div>
        </template>
        <template v-else-if="group && view === 'pending'">
          <h2>{{ tr('待处理消息', 'Pending entries') }} · {{ display(group.name) || '␀' }} · {{ group.pending }}</h2>
          <StatusNotice v-if="pendingError" tone="error" :text="pendingError" :retry="!busy" @retry="withBusy(loadGroup)" />
          <EmptyState v-else-if="!pending.length && !busy" compact>{{ tr('没有待处理消息', 'No pending entries') }}</EmptyState>
          <div v-if="pending.length" class="table-wrap">
            <NTable size="small" :bordered="false" class="data-table">
              <thead><tr>
                <th>{{ tr('消息 ID', 'Entry ID') }}</th><th>{{ tr('当前消费者', 'Current consumer') }}</th>
                <th>{{ tr('空闲时间（毫秒）', 'Idle (ms)') }}</th><th>{{ tr('投递次数', 'Deliveries') }}</th><th v-if="!readOnly">{{ tr('操作', 'Actions') }}</th>
              </tr></thead>
              <tbody>
                <tr v-for="[id, owner, idle, deliveries] in pending" :key="id">
                  <td class="mono">{{ id }}</td><td class="mono">{{ display(owner) || '␀' }}</td><td>{{ idle }}</td><td>{{ deliveries }}</td>
                  <td v-if="!readOnly" class="stream-entry-actions row-ops">
                    <NButton size="small" :disabled="busy" @click="acknowledge(id)">{{ tr('确认消息', 'Acknowledge') }}</NButton>
                    <NButton size="small" :disabled="busy" @click="claimEntry(id)">{{ tr('认领…', 'Claim…') }}</NButton>
                  </td>
                </tr>
              </tbody>
            </NTable>
          </div>
          <div v-if="pendingCursor !== null" class="form-actions">
            <NButton size="small" :disabled="busy" @click="loadMore">{{ tr('加载更多待处理消息', 'Load more pending entries') }}</NButton>
          </div>
        </template>
      </template>
    </div>
  </section>

  <WorkspaceDialog v-if="dialog" :title-id="titleId" :busy="busy" @close="closeDialog">
    <template #default="{ requestClose, closeDisabled }">
      <form class="modal small-modal stream-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" @submit.prevent="saveDialog">
        <header class="modal-header">
          <h2 :id="titleId">{{ dialog.kind === 'create' ? tr('创建消费组', 'Create consumer group') : tr('认领消息', 'Claim entry') }}</h2>
          <IconButton :icon="X" :label="tr('关闭', 'Close')" :disabled="closeDisabled" @click="requestClose" />
        </header>
        <div class="modal-body">
          <StatusNotice v-if="readOnly" tone="info" :title="tr('只读连接', 'Read-only connection')" />
          <StatusNotice v-if="error" tone="error" :text="error" />
          <fieldset :disabled="busy || readOnly" class="stream-dialog-fields">
            <div v-if="dialog.kind === 'create'" class="form-grid">
              <label>{{ tr('组名', 'Group name') }}<input v-model="dialog.name" required></label>
              <label>{{ tr('起始 ID', 'Start ID') }}<input v-model.trim="dialog.start" required placeholder="$"></label>
              <p class="muted stream-form-help">{{ tr('输入 $ 仅处理新消息，输入 0 可从头读取。', 'Use $ for new entries only, or 0 to read from the beginning.') }}</p>
            </div>
            <div v-else class="form-grid">
              <p class="mono stream-form-help">{{ dialog.id }}</p>
              <label v-if="consumers.length">{{ tr('目标消费者', 'Target consumer') }}
                <select v-model="dialog.target">
                  <option value="">{{ tr('输入新消费者名称', 'Enter a new consumer name') }}</option>
                  <option v-for="item in consumers" :key="item.id" :value="item.id">{{ display(item.name) || '␀' }}</option>
                </select>
              </label>
              <label v-if="!dialog.target">{{ tr('新消费者名称', 'New consumer name') }}<input v-model="dialog.consumer" required></label>
              <label>{{ tr('最小空闲时间（毫秒）', 'Minimum idle (ms)') }}<input v-model.number="dialog.minIdle" type="number" min="0" max="9007199254740991" required></label>
            </div>
          </fieldset>
        </div>
        <footer class="modal-footer end">
          <NButton size="small" :disabled="closeDisabled" @click="requestClose">{{ tr('取消', 'Cancel') }}</NButton>
          <NButton size="small" type="primary" attr-type="submit" :loading="busy" :disabled="readOnly || busy">
            {{ dialog.kind === 'create' ? tr('创建', 'Create') : tr('认领', 'Claim') }}
          </NButton>
        </footer>
      </form>
    </template>
  </WorkspaceDialog>
</template>

<style scoped>
.stream-groups { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.stream-groups h2 { font-size: 14px; font-weight: 650; overflow-wrap: anywhere; }
.stream-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--border); }
.stream-tabs button { min-height: 28px; padding: 4px 8px; border: 0; border-radius: 5px; background: transparent; color: var(--muted); cursor: pointer; }
.stream-tabs button:hover { background: var(--hover); color: var(--ink); }
.stream-tabs button[aria-selected='true'] { background: var(--accent-soft); color: var(--accent-text); font-weight: 650; }
.stream-tabs button:focus-visible, .stream-view:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.stream-view { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0; }
.stream-view .table-wrap { border-radius: 6px; }
.stream-view :deep(th), .stream-view :deep(td) { height: 28px; padding: 0 8px; }
.stream-entry-actions > :not(:last-child) { margin-right: 8px; }
.stream-dialog { width: min(calc(100vw / var(--ui-scale, 1) - 24px), 440px); border-radius: 8px; }
.stream-dialog .modal-header, .stream-dialog .modal-footer { min-height: 0; padding: 8px 16px; }
.stream-dialog .modal-header h2 { font-size: 14px; }
.stream-dialog-fields { min-width: 0; padding: 0; border: 0; }
.stream-dialog-fields :is(input, select) { min-width: 0; }
.stream-form-help { grid-column: 1 / -1; overflow-wrap: anywhere; }
</style>
