<script setup>
defineProps({
  icon: { type: [String, Object, Function], default: undefined },
  compact: Boolean,
})
</script>

<template>
  <div class="shared-empty-state" :data-compact="compact ? 'true' : 'false'">
    <component v-if="icon" :is="icon" class="shared-empty-state__icon" aria-hidden="true" />
    <div class="shared-empty-state__content"><slot /></div>
    <div v-if="$slots.actions" class="shared-empty-state__actions" data-slot="actions"><slot name="actions" /></div>
  </div>
</template>
