<script setup>
import { inject } from 'vue'
import { Activity, Clock3, HardDrive, Radio, Search, Server, Terminal } from '@lucide/vue'

defineProps({ connected: Boolean, mode: String })
const emit = defineEmits(['update:mode', 'tool'])
const tr = inject('tr')
const groups = [
  ['工作', 'Work', [['server', Server, '服务器概览', 'Server overview'], ['cli', Terminal, 'Redis CLI', 'Redis CLI'], ['search', Search, 'Redis Search', 'Redis Search']]],
  ['观测', 'Observe', [['profiler', Activity, '实时监控', 'Profiler'], ['pubsub', Radio, '发布订阅', 'Pub/Sub'], ['logs', Activity, '命令日志', 'Command log']]],
  ['维护', 'Maintain', [['slow', Clock3, '慢日志', 'Slow log'], ['memory', HardDrive, '内存分析', 'Memory analysis']]],
]
</script>

<template>
  <aside id="workspace-sidebar" class="sidebar">
    <div class="sidebar-content">
      <div class="sidebar-top"><slot name="header" /></div>
      <slot name="connections" />
      <section v-if="connected" class="browser">
        <slot name="database" />
        <div class="resource-switch" role="group" :aria-label="tr('资源视图', 'Resource view')">
          <NButton size="small" quaternary class="flat" :aria-pressed="mode === 'keys'" @click="emit('update:mode', 'keys')">{{ tr('键', 'Keys') }}</NButton>
          <NButton size="small" quaternary class="flat" :aria-pressed="mode === 'tools'" @click="emit('update:mode', 'tools')">{{ tr('工具', 'Tools') }}</NButton>
        </div>
        <div v-show="mode === 'keys'" class="sidebar-keys"><slot name="keys" /></div>
        <nav v-if="mode === 'tools'" class="sidebar-tools" :aria-label="tr('数据库工具', 'Database tools')">
          <section v-for="[zh, en, tools] in groups" :key="en">
            <h3>{{ tr(zh, en) }}</h3>
            <NButton v-for="[id, icon, labelZh, labelEn] in tools" :key="id" size="small" quaternary class="flat" @click="emit('tool', id)">
              <component :is="icon" :size="14" aria-hidden="true" />{{ tr(labelZh, labelEn) }}
            </NButton>
          </section>
        </nav>
      </section>
    </div>
    <slot name="footer" />
  </aside>
</template>

<style scoped>
.resource-switch { display: flex; flex: none; gap: 4px; padding: 8px 12px 0; }
.resource-switch > button { flex: 1; }
.sidebar-keys { display: flex; flex: 1; flex-direction: column; min-height: min-content; }
.sidebar-tools { overflow: auto; padding: 8px 12px; }
.sidebar-tools h3 { margin: 8px 4px 4px; color: var(--muted); font-size: 12px; font-weight: 650; }
.sidebar-tools button { display: flex; justify-content: flex-start; width: 100%; }
</style>
