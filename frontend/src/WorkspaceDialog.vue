<script setup>
import { computed, nextTick, onBeforeMount, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { NModal } from 'naive-ui'

const props = defineProps({
  titleId: String,
  descriptionId: String,
  busy: Boolean,
  dismissible: { type: Boolean, default: true },
})
const emit = defineEmits(['close'])
const generatedTitleId = useId()
const resolvedTitleId = computed(() => props.titleId || generatedTitleId)
const canClose = computed(() => !props.busy && props.dismissible)
const closeDisabled = computed(() => !canClose.value)
const frame = ref(null)
const returnFocus = ref(null)

/** Every dismissal path shares the busy and dismissible guard. */
function requestClose() {
  if (canClose.value) emit('close')
}

/** Forward Naive UI mask/update requests without allowing an unguarded close. */
function update(open) {
  if (!open) requestClose()
}

/** Return visible, enabled controls in DOM order, including Naive UI inputs. */
function focusableControls() {
  if (!frame.value) return []
  const selector = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
  ].join(',')
  return [...frame.value.querySelectorAll(selector)].filter(element =>
    element.tabIndex >= 0 &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    element.getClientRects().length > 0,
  )
}

/** Prefer the caller's autofocus target, otherwise the first operable control. */
async function enterFocus() {
  await nextTick()
  const controls = focusableControls()
  const preferred = frame.value?.querySelector('[autofocus]')
  const target = controls.includes(preferred) ? preferred : controls[0]
  if (target) target.focus({ preventScroll: true })
  else frame.value?.focus({ preventScroll: true })
}

/** Keep Tab/Shift+Tab and Escape inside the dialog without changing form keys. */
function keydown(event) {
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    requestClose()
    return
  }
  if (event.key !== 'Tab') return
  const controls = focusableControls()
  if (!controls.length) {
    event.preventDefault()
    frame.value?.focus({ preventScroll: true })
    return
  }
  const first = controls[0]
  const last = controls[controls.length - 1]
  const active = document.activeElement
  const outside = !frame.value?.contains(active)
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault()
    first.focus()
  }
}

onBeforeMount(() => {
  // Capture before native autofocus or Naive UI can move focus into the dialog.
  returnFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
})

onMounted(() => {
  void enterFocus()
})

onBeforeUnmount(() => {
  const target = returnFocus.value
  returnFocus.value = null
  if (!target?.isConnected) return
  // Wait for Naive UI's leaving overlay so a replacement dialog keeps its focus.
  requestAnimationFrame(() => {
    if (!document.querySelector('.modal-frame')) target.focus({ preventScroll: true })
  })
})
</script>

<template>
  <NModal
    :show="true"
    :block-scroll="false"
    :auto-focus="false"
    :close-on-esc="false"
    :mask-closable="canClose"
    to="#overlay-host"
    @update:show="update"
  >
    <div
      ref="frame"
      class="modal-frame"
      role="document"
      tabindex="-1"
      :aria-labelledby="resolvedTitleId"
      :aria-describedby="descriptionId || undefined"
      :aria-busy="busy || undefined"
      @keydown="keydown"
    >
      <slot
        :request-close="requestClose"
        :close-disabled="closeDisabled"
        :title-id="resolvedTitleId"
        :description-id="descriptionId"
      />
    </div>
  </NModal>
</template>
