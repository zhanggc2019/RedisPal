<script setup>
defineProps({
  icon: { type: [String, Object, Function], default: undefined },
})
</script>

<template>
  <header class="shared-panel-header">
    <component v-if="icon" :is="icon" class="shared-panel-header__icon" aria-hidden="true" />
    <div class="shared-panel-header__heading">
      <div v-if="$slots.eyebrow" class="shared-panel-header__eyebrow" data-slot="eyebrow"><slot name="eyebrow" /></div>
      <h2 class="shared-panel-header__title" data-slot="title"><slot name="title" /></h2>
    </div>
    <div v-if="$slots.actions" class="shared-panel-header__actions" data-slot="actions"><slot name="actions" /></div>
  </header>
</template>
