<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ChevronDown, ChevronRight, Folder, KeyRound } from '@lucide/vue'
import { display, identity } from './model.js'

const props = defineProps({ nodes: Array, expanded: Object, selected: Object, active: String, multi: Boolean })
const emit = defineEmits(['open', 'toggle', 'check'])
const viewport = ref(null)
const scroll = ref(0)
const height = ref(600)
const rowHeight = 30
const overscan = 8
let observer

/** Flatten only expanded directories so large closed folders don't generate DOM. */
const rows = computed(() => {
  const visible = []
  function visit(nodes, depth) {
    for (const node of nodes) {
      visible.push({ node, depth })
      if (node.children.length && props.expanded.has(node.id)) visit(node.children, depth + 1)
    }
  }
  visit(props.nodes, 0)
  return visible
})
const start = computed(() => rows.value.length < 800 ? 0 : Math.max(0, Math.min(Math.floor(scroll.value / rowHeight), rows.value.length - 1) - overscan))
const end = computed(() => rows.value.length < 800 ? rows.value.length : Math.min(rows.value.length, start.value + Math.ceil(height.value / rowHeight) + overscan * 2))
const visible = computed(() => rows.value.slice(start.value, end.value))

/** Open the exact key or expand a directory that has no value of its own. */
function activate(node) {
  if (node.value !== undefined) emit('open', node.value)
  else emit('toggle', node.id)
}

/** Move along visible tree rows and open or close the current folder by keyboard. */
async function navigate(event, node, index) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const target = Math.max(0, Math.min(rows.value.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    const top = target * rowHeight
    const pane = viewport.value
    if (top < pane.scrollTop) pane.scrollTop = top
    else if (top + rowHeight > pane.scrollTop + pane.clientHeight) pane.scrollTop = top + rowHeight - pane.clientHeight
    scroll.value = pane.scrollTop
    await nextTick()
    pane.querySelector('[data-index="' + target + '"]')?.focus({ preventScroll: true })
  }
  else if (event.key === 'ArrowRight' && node.children.length && !props.expanded.has(node.id)) emit('toggle', node.id)
  else if (event.key === 'ArrowLeft' && node.children.length && props.expanded.has(node.id)) emit('toggle', node.id)
  else return
  event.preventDefault()
}

onMounted(() => {
  observer = new ResizeObserver(() => { height.value = viewport.value.clientHeight })
  observer.observe(viewport.value)
})
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <div ref="viewport" class="tree-list" @scroll.passive="scroll = $event.currentTarget.scrollTop">
    <div v-if="start" :style="{ height: start * rowHeight + 'px' }"></div>
    <div v-for="({ node, depth }, index) in visible" :key="node.id" class="tree-row" tabindex="0" :data-index="start + index"
      :class="{ current: node.value !== undefined && identity(node.value) === active }"
      :style="{ paddingLeft: 7 + depth * 15 + 'px' }"
      @keydown.enter.self="activate(node)" @keydown="navigate($event, node, start + index)">
      <NButton size="small" quaternary v-if="node.children.length" class="icon flat folder-toggle" :aria-label="node.title"
        :aria-expanded="expanded.has(node.id)" @click="emit('toggle', node.id)">
        <ChevronDown v-if="expanded.has(node.id)" :size="13" /><ChevronRight v-else :size="13" />
      </NButton>
      <span v-else class="tree-spacer"></span>
      <input v-if="multi && node.value !== undefined" type="checkbox" :aria-label="display(node.value)"
        :checked="selected.has(identity(node.value))" @change="emit('check', node.value)">
      <NButton size="small" quaternary class="flat tree-key" :title="node.value === undefined ? node.title : display(node.value)" @click="activate(node)">
        <Folder v-if="node.children.length" :size="14" /><KeyRound v-else :size="13" />
        <span>{{ node.title || '␀' }}</span>
      </NButton>
    </div>
    <div v-if="end < rows.length" :style="{ height: (rows.length - end) * rowHeight + 'px' }"></div>
  </div>
</template>
