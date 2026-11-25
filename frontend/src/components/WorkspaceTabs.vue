<script setup>
import { inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { nextTabIndex, tabIcon } from '../tabs.js'

const props = defineProps({
  tabs: { type: Array, required: true },
  activeId: { type: String, required: true },
  focusTabId: { type: String, default: null },
  names: { type: Object, required: true },
})
const emit = defineEmits(['activate', 'close', 'menu', 'focus-request-complete'])
const tr = inject('tr', (zh, en) => en)
const list = ref(null)
const buttons = new Map()
const focusedId = ref(props.activeId)
let resizeObserver

/** Keep the accessible name in sync with the visible dirty indicator. */
function accessibleName(tab) {
  const name = props.names[tab.id] || ''
  return name + (tab.dirty ? tr('，未保存修改', ', unsaved changes') : '')
}

/** Retain DOM references without requiring globally unique tab IDs. */
function setButton(id, element) {
  if (element) buttons.set(id, element)
  else buttons.delete(id)
}

/** Move only the selected tab when the strip overflows horizontally. */
function scrollActive(id) {
  const strip = list.value
  const button = buttons.get(id)
  if (!strip || !button) return
  const stripBox = strip.getBoundingClientRect()
  const buttonBox = button.getBoundingClientRect()
  const edge = 8
  if (buttonBox.left < stripBox.left + edge) strip.scrollLeft += buttonBox.left - stripBox.left - edge
  else if (buttonBox.right > stripBox.right - edge) strip.scrollLeft += buttonBox.right - stripBox.right + edge
}

/** Watch the strip and selected button for width, font, zoom, and label changes. */
function observeActive() {
  resizeObserver?.disconnect()
  if (!list.value) return
  resizeObserver?.observe(list.value)
  const button = buttons.get(props.activeId)
  if (button) resizeObserver?.observe(button)
}
/** Focus without allowing the browser to undo the strip's horizontal scrolling. */
function focus(id) {
  focusedId.value = id
  buttons.get(id)?.focus({ preventScroll: true })
}

/** Activate and focus the tab reached by a roving keyboard command. */
function navigate(event, tab, index) {
  const next = nextTabIndex(index, props.tabs.length, event.key)
  if (next < 0 || next === index) return
  event.preventDefault()
  const target = props.tabs[next]
  focusedId.value = target.id
  emit('activate', target.id)
  nextTick(() => focus(target.id))
}

/** Ask App to choose the surviving tab; every close entry point uses this event. */
function close(tab) {
  emit('close', tab.id)
}

/** Preserve the existing horizontal trackpad behavior on the overflow strip. */
function wheel(event) {
  event.currentTarget.scrollLeft += event.deltaY
}

watch(() => props.activeId, async id => {
  focusedId.value = id
  await nextTick()
  observeActive()
  scrollActive(id)
})

watch(() => props.focusTabId, async id => {
  if (!id) return
  await nextTick()
  if (props.focusTabId !== id) return
  focus(id)
  scrollActive(props.activeId)
  emit('focus-request-complete', id)
}, { flush: 'post' })

onMounted(() => {
  resizeObserver = new ResizeObserver(() => scrollActive(props.activeId))
  observeActive()
  scrollActive(props.activeId)
})
onUnmounted(() => resizeObserver?.disconnect())
</script>

<template>
  <div ref="list" class="tabs" role="tablist" :aria-label="tr('工作区标签', 'Workspace tabs')" @wheel.passive="wheel">
    <div v-for="(tab, index) in tabs" :key="tab.id" class="tab-shell"
      :class="{ active: tab.id === activeId, dirty: tab.dirty }"
      @contextmenu.prevent.stop="emit('menu', $event, tab)" @focusin="focusedId = tab.id">
      <button type="button" role="tab" class="tab-button" :id="`workspace-tab-${index}`" :ref="element => setButton(tab.id, element)"
        :aria-controls="`workspace-panel-${index}`" :aria-selected="tab.id === activeId" :aria-label="accessibleName(tab)" :title="accessibleName(tab)"
        :tabindex="tab.id === focusedId ? 0 : -1" @click="emit('activate', tab.id)" @keydown="navigate($event, tab, index)">
        <component :is="tabIcon(tab.kind)" class="tab-icon" :size="14" aria-hidden="true" />
        <span class="tab-label">{{ names[tab.id] }}</span>
        <span v-if="tab.dirty" class="tab-dirty" aria-hidden="true"></span>
      </button>
      <button v-if="tab.kind !== 'home'" type="button" class="close-tab"
        :aria-label="tr('关闭标签', 'Close tab')" :title="tr('关闭标签', 'Close tab')" @click="close(tab)">
        <X :size="13" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
