<script setup>
import { computed, inject } from 'vue'
import { CircleCheck, CircleX, Clock3, Info, TriangleAlert } from '@lucide/vue'

const props = defineProps({
  tone: {
    type: String,
    required: true,
    default: 'info',
    validator: value => ['info', 'success', 'warning', 'error', 'stale'].includes(value),
  },
  title: { type: String, default: undefined },
  text: { type: String, default: undefined },
  retry: Boolean,
})
const emit = defineEmits(['retry'])
const tr = inject('tr', (zh) => zh)

const icons = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleX, stale: Clock3 }
const icon = computed(() => icons[props.tone])
const noticeTitle = computed(() => props.title || (props.tone === 'stale' ? tr('数据可能已过期', 'Data may be stale') : undefined))
const noticeText = computed(() => {
  if (props.tone !== 'stale') return props.text
  const cachedText = tr('当前显示缓存数据（可能已过期），请重试以获取最新结果。', 'Showing cached data that may be stale. Retry to fetch the latest result.')
  return props.text ? `${props.text}\n${cachedText}` : cachedText
})
const showRetry = computed(() => props.retry || props.tone === 'stale')
</script>

<template>
  <div
    class="shared-status-notice"
    :data-tone="tone"
    :role="tone === 'error' ? 'alert' : 'status'"
    aria-atomic="true"
  >
    <component :is="icon" class="shared-status-notice__icon" :size="16" aria-hidden="true" />
    <div class="shared-status-notice__body">
      <strong v-if="noticeTitle">{{ noticeTitle }}</strong>
      <p v-if="noticeText">{{ noticeText }}</p>
    </div>
    <button v-if="showRetry" type="button" class="shared-status-notice__retry" @click="emit('retry')">{{ tr('重试', 'Retry') }}</button>
  </div>
</template>
