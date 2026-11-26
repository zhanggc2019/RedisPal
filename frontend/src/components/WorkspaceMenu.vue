<script setup>
import { nextTick, ref, watch } from 'vue'

const props = defineProps({ context: Object, label: String })
const emit = defineEmits(['close'])
const panel = ref(null)

function items() {
  return [...panel.value.querySelectorAll('[role="menuitem"]:not(:disabled)')]
}

function dismiss(restore = true) {
  if (restore) props.context.anchor?.focus({ preventScroll: true })
  emit('close')
}

function navigate(event) {
  if (event.key === 'Tab') {
    dismiss()
    return
  }
  const buttons = items()
  const index = buttons.indexOf(document.activeElement)
  const targets = { ArrowDown: (index + 1) % buttons.length, ArrowUp: index <= 0 ? buttons.length - 1 : index - 1, Home: 0, End: buttons.length - 1 }
  if (event.key !== 'Escape' && !Object.hasOwn(targets, event.key)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') dismiss()
  else buttons[targets[event.key]]?.focus()
}

function select(event) {
  if (event.target.closest('[role="menuitem"]')) props.context.anchor?.focus({ preventScroll: true })
}

/** Keep menus in the viewport and anchor footer commands above their trigger. */
watch(() => props.context, async current => {
  if (!current) return
  await nextTick()
  if (props.context !== current || !panel.value) return
  const bounds = panel.value.getBoundingClientRect()
  const scale = bounds.width / panel.value.offsetWidth
  const topEnd = current.placement === 'top-end'
  const left = topEnd ? current.x - bounds.width : current.x
  const top = topEnd ? current.y - bounds.height - 4 : current.y
  panel.value.style.left = Math.max(4, Math.min(left, innerWidth - bounds.width - 4)) / scale + 'px'
  panel.value.style.top = Math.max(4, Math.min(top, innerHeight - bounds.height - 4)) / scale + 'px'
  items()[0]?.focus()
}, { flush: 'post', immediate: true })
</script>

<template>
  <div v-if="context" ref="panel" class="context-menu" role="menu" :aria-label="label"
    @keydown="navigate" @click.capture="select" @click.stop>
    <slot />
  </div>
</template>
