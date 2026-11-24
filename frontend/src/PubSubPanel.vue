<script setup>
import { inject, onUnmounted, ref, shallowRef, useId } from 'vue'
import { Radio } from '@lucide/vue'
import { call, command } from './api.js'
import { display } from './model.js'

const props = defineProps({ tab: Object, connection: Object })
const tr = inject('tr')
const formId = useId()
const subscriptionMode = ref('SUBSCRIBE')
const subscriptionChannel = ref('')
const subscription = shallowRef(null)
const subscriptionBusy = ref(false)
const subscriptionError = ref('')
const publishMode = ref('PUBLISH')
const publishChannel = ref('')
const message = ref('')
const publishBusy = ref(false)
const publishError = ref('')
const publishResult = ref(null)
const messages = shallowRef([])
const received = ref(0)
const dropped = ref(0)
const messageLimit = 500
let sequence = 0
let pollTimer
let closed = false

/** Open a feed with its own token so a late response cannot affect another subscription. */
async function startSubscription() {
  if (subscription.value || subscriptionBusy.value || !subscriptionChannel.value) return
  subscriptionBusy.value = true
  subscriptionError.value = ''
  const stream = { token: crypto.randomUUID(), mode: subscriptionMode.value, channel: subscriptionChannel.value }
  try {
    await call('StartFeed', props.connection.id, props.tab.db, stream.token, stream.mode, [stream.channel])
    if (closed) {
      await call('StopFeed', stream.token)
      return
    }
    subscription.value = stream
    poll(stream)
  } catch (error) {
    if (!closed) subscriptionError.value = error.message || String(error)
  } finally {
    subscriptionBusy.value = false
  }
}

/** Keep the latest records and ignore replies from an earlier subscription. */
async function poll(stream) {
  try {
    const batch = await call('PollFeed', stream.token)
    if (subscription.value !== stream) return
    if (batch.messages.length) {
      const incoming = batch.messages.map(item => ({ ...item, id: ++sequence, mode: stream.mode }))
      messages.value = [...incoming.reverse(), ...messages.value].slice(0, messageLimit)
      received.value += incoming.length
    }
    dropped.value += batch.dropped
    if (batch.error) throw new Error(batch.error)
  } catch (error) {
    if (subscription.value !== stream) return
    subscriptionError.value = error.message || String(error)
    await stopSubscription()
  } finally {
    if (subscription.value === stream) pollTimer = setTimeout(() => poll(stream), 400)
  }
}

/** Detach pending poll replies before releasing the dedicated Redis connection. */
async function stopSubscription() {
  const stream = subscription.value
  if (!stream) return
  subscription.value = null
  subscriptionBusy.value = true
  clearTimeout(pollTimer)
  try {
    await call('StopFeed', stream.token)
  } catch (error) {
    if (!closed && !subscriptionError.value) subscriptionError.value = error.message || String(error)
  } finally {
    subscriptionBusy.value = false
  }
}

/** Send the exact text payload, including line breaks and empty messages. */
async function publish() {
  if (props.connection.readOnly || publishBusy.value || !publishChannel.value) return
  publishBusy.value = true
  publishResult.value = null
  publishError.value = ''
  try {
    publishResult.value = await command(props.connection.id, props.tab.db, publishMode.value, publishChannel.value, message.value)
  } catch (error) {
    publishError.value = error.message || String(error)
  } finally {
    publishBusy.value = false
  }
}

/** Clear the displayed history and counters without stopping the live subscription. */
function clearMessages() {
  messages.value = []
  received.value = 0
  dropped.value = 0
}

onUnmounted(() => {
  closed = true
  stopSubscription()
})
</script>

<template>
  <section class="panel">
    <header class="panel-heading">
      <div class="panel-title">
        <div class="eyebrow">{{ connection.name }}</div>
        <h1><Radio :size="23" />{{ tr('发布订阅', 'Pub/Sub') }}</h1>
      </div>
    </header>

    <div class="exchange">
      <form class="exchange-form" @submit.prevent="startSubscription">
        <header>
          <h2>{{ tr('订阅', 'Subscribe') }}</h2>
          <NTag size="small" :type="subscription ? 'success' : 'default'" :bordered="false" role="status">
            {{ subscription ? tr('接收中', 'Listening') : tr('未订阅', 'Idle') }}
          </NTag>
        </header>
        <label>
          {{ tr('订阅方式', 'Subscription mode') }}
          <select v-model="subscriptionMode" :disabled="Boolean(subscription) || subscriptionBusy">
            <option value="SUBSCRIBE">{{ tr('频道', 'Channel') }} (SUBSCRIBE)</option>
            <option value="PSUBSCRIBE">{{ tr('模式', 'Pattern') }} (PSUBSCRIBE)</option>
            <option value="SSUBSCRIBE">{{ tr('分片频道', 'Sharded channel') }} (SSUBSCRIBE)</option>
          </select>
        </label>
        <div class="field">
          <label :for="formId + '-subscription'">{{ subscriptionMode === 'PSUBSCRIBE' ? tr('订阅模式', 'Subscription pattern') : tr('订阅频道', 'Subscription channel') }}</label>
          <NInput v-model:value="subscriptionChannel" size="small" :disabled="Boolean(subscription) || subscriptionBusy"
            :placeholder="subscriptionMode === 'PSUBSCRIBE' ? 'events:*' : 'events:demo'"
            :input-props="{ id: formId + '-subscription', spellcheck: false }" />
        </div>
        <div class="form-actions">
          <NButton v-if="subscription" size="small" @click="stopSubscription">{{ tr('停止订阅', 'Stop subscription') }}</NButton>
          <NButton v-else size="small" type="primary" attr-type="submit" :loading="subscriptionBusy" :disabled="!subscriptionChannel">
            {{ tr('开始订阅', 'Start subscription') }}
          </NButton>
        </div>
        <p v-if="subscriptionError" class="notice error" role="alert">{{ subscriptionError }}</p>
      </form>

      <form class="exchange-form" @submit.prevent="publish">
        <header>
          <h2>{{ tr('发布', 'Publish') }}</h2>
          <NTag v-if="connection.readOnly" size="small" :bordered="false">{{ tr('只读连接', 'Read-only connection') }}</NTag>
        </header>
        <label>
          {{ tr('发布方式', 'Publish mode') }}
          <select v-model="publishMode" :disabled="connection.readOnly || publishBusy">
            <option value="PUBLISH">{{ tr('频道', 'Channel') }} (PUBLISH)</option>
            <option value="SPUBLISH">{{ tr('分片频道', 'Sharded channel') }} (SPUBLISH)</option>
          </select>
        </label>
        <div class="field">
          <label :for="formId + '-publish'">{{ tr('发布频道', 'Publish channel') }}</label>
          <NInput v-model:value="publishChannel" size="small" placeholder="events:demo" :disabled="connection.readOnly || publishBusy"
            :input-props="{ id: formId + '-publish', spellcheck: false }" />
        </div>
        <div class="field">
          <label :for="formId + '-message'">{{ tr('消息', 'Message') }}</label>
          <NInput v-model:value="message" type="textarea" size="small" :rows="3" placeholder="" :disabled="connection.readOnly || publishBusy"
            :input-props="{ id: formId + '-message', spellcheck: false }" />
        </div>
        <div class="form-actions">
          <p v-if="publishResult !== null" class="muted publish-result" role="status">
            {{ tr(`已发布 · ${publishResult} 个订阅客户端接收`, `Published · ${publishResult} ${publishResult === 1 ? 'receiving client' : 'receiving clients'}`) }}
          </p>
          <NButton size="small" type="primary" attr-type="submit" :loading="publishBusy" :disabled="connection.readOnly || !publishChannel">
            {{ tr('发布', 'Publish') }}
          </NButton>
        </div>
        <p v-if="publishError" class="notice error" role="alert">{{ publishError }}</p>
      </form>
    </div>

    <section class="inbox">
      <header>
        <div>
          <h2>{{ tr('接收记录', 'Received messages') }}</h2>
          <p class="muted">
            {{ tr(`已接收 ${received} 条`, `${received} received`) }}
            <template v-if="received > messageLimit">{{ tr(` · 显示最近 ${messageLimit} 条`, ` · Showing latest ${messageLimit}`) }}</template>
            <template v-if="dropped">{{ tr(` · 缓冲区跳过 ${dropped} 条`, ` · ${dropped} dropped from the buffer`) }}</template>
          </p>
        </div>
        <NButton size="small" :disabled="!received && !dropped" @click="clearMessages">{{ tr('清空记录', 'Clear messages') }}</NButton>
      </header>
      <div class="table-wrap inbox-table">
        <NTable size="small" :bordered="false" class="data-table messages">
          <thead>
            <tr><th>{{ tr('接收时间', 'Received at') }}</th><th>{{ tr('频道', 'Channel') }}</th><th>{{ tr('方式', 'Mode') }}</th><th>{{ tr('消息', 'Message') }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in messages" :key="item.id">
              <td class="received-time mono" :title="new Date(item.time).toLocaleString()">{{ new Date(item.time).toLocaleTimeString() }}</td>
              <td class="mono">{{ item.channel }}</td>
              <td class="mono muted">{{ item.mode }}</td>
              <td><pre v-if="item.value !== ''" class="payload">{{ display(item.value) }}</pre><span v-else class="muted">{{ tr('空消息', 'Empty message') }}</span></td>
            </tr>
            <tr v-if="!messages.length">
              <td colspan="4" class="empty-cell">{{ subscription ? tr('正在等待消息', 'Waiting for messages') : tr('订阅后可在此查看实时消息', 'Subscribe to receive messages here') }}</td>
            </tr>
          </tbody>
        </NTable>
      </div>
    </section>
  </section>
</template>

<style scoped>
.exchange { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.exchange-form {
  align-self: start; display: grid; gap: 10px; min-width: 0; padding: 14px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--panel);
}
.exchange-form header, .inbox header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.exchange-form h2, .inbox h2 { font-size: 14px; }
.exchange-form .field, .exchange-form > label { display: grid; gap: 5px; color: var(--muted); font-size: 13px; }
.exchange-form .form-actions { flex-wrap: wrap; justify-content: flex-end; }
.publish-result { margin-right: auto; }
.inbox { display: grid; gap: 9px; min-width: 0; }
.inbox p { font-size: 12px; margin-top: 3px; }
.inbox-table { max-height: min(55vh, 620px); }
.messages :deep(th) { position: sticky; top: 0; }
.messages :deep(td:first-child), .messages :deep(td:nth-child(3)) { width: 1%; white-space: nowrap; }
.messages :deep(td:nth-child(2)) { width: 23%; }
.payload { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 880px) {
  .exchange { grid-template-columns: 1fr; }
}
</style>
