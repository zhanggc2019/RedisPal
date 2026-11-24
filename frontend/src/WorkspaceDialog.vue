<script setup>
import { NModal } from 'naive-ui'

const emit = defineEmits(['close'])

/** Forward escape and mask dismissal without changing the form's submit behavior. */
function update(open) {
  if (!open) emit('close')
}
</script>

<template>
  <NModal :show="true" :block-scroll="false" to="#overlay-host" @update:show="update">
    <!-- The focus trap finds the modal content through its root div. -->
    <div class="modal-frame"><slot /></div>
  </NModal>
</template>
