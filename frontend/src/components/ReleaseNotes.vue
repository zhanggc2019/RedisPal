<script setup>
import { computed, inject } from 'vue'

const props = defineProps({ notes: { type: String, default: '' } })
const tr = inject('tr')

/** Use the interface language, falling back to Chinese or the available notes. */
const text = computed(() => {
  const parts = (props.notes || '').split(/^##[ \t]+(中文|English)[ \t]*\r?$/gim)
  const localized = {}
  for (let index = 1; index < parts.length; index += 2) {
    localized[parts[index].toLowerCase()] = parts[index + 1].trim()
  }
  return localized[tr('中文', 'english')] || localized['中文'] || localized.english || parts[0].trim()
})

/** Format simple changelog lists while keeping all remote content as text. */
const items = computed(() => {
  const lines = text.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.every(line => /^[-*] /.test(line)) ? lines.map(line => line.slice(2)) : null
})
</script>

<template>
  <section v-if="text" class="release-notes">
    <h3>{{ tr('更新日志', 'Release notes') }}</h3>
    <ul v-if="items">
      <li v-for="(item, index) in items" :key="index">{{ item }}</li>
    </ul>
    <p v-else>{{ text }}</p>
  </section>
</template>
