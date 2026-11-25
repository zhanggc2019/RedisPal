<script setup>
import { NButton } from 'naive-ui'

defineProps({
  label: { type: String, required: true },
  title: { type: String, default: undefined },
  icon: { type: [String, Object, Function], required: true },
  size: { type: String, default: 'small', validator: value => ['small', 'medium'].includes(value) },
  danger: Boolean,
  loading: Boolean,
  disabled: Boolean,
})
const emit = defineEmits(['click'])

function click(event) {
  emit('click', event)
}
</script>

<template>
  <NButton
    quaternary
    :size="size"
    :type="danger ? 'error' : 'default'"
    class="shared-icon-button"
    :data-size="size"
    :data-danger="danger ? 'true' : undefined"
    :data-loading="loading ? 'true' : undefined"
    :aria-label="label"
    :aria-busy="loading ? 'true' : undefined"
    :title="title ?? label"
    :disabled="disabled || loading"
    :loading="loading"
    @click="click"
  >
    <template #icon>
      <component :is="icon" aria-hidden="true" />
    </template>
  </NButton>
</template>
