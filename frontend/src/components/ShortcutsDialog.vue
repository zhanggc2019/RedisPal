<script setup>
import { inject } from 'vue'
import { X } from '@lucide/vue'

const emit = defineEmits(['close'])
const tr = inject('tr')
const groups = [
  { zh: '导航', en: 'Navigation', items: [['搜索键', 'Search keys', 'Ctrl + F'], ['关闭标签', 'Close tab', 'Ctrl + W'], ['切换标签', 'Move between focused tabs', '← / →']] },
  { zh: '连接', en: 'Connections', items: [['新建连接（未连接或只读时）', 'New connection (disconnected or read-only)', 'Ctrl + N']] },
  { zh: '编辑', en: 'Editing', items: [['新建键（已连接且可写时）', 'New key (connected and writable)', 'Ctrl + N'], ['刷新键列表', 'Refresh keys', 'Ctrl + R']] },
  { zh: '工具', en: 'Tools', items: [['打开命令行', 'Open CLI', 'Ctrl + B'], ['执行搜索查询（查询框内）', 'Run Search query (in query field)', 'Ctrl + Enter']] },
  { zh: '窗口', en: 'Window', items: [['最大化', 'Toggle maximize', 'Ctrl + Enter'], ['最小化', 'Minimize', 'Ctrl + M']] },
]
</script>

<template>
  <WorkspaceDialog title-id="shortcuts-title" @close="emit('close')">
    <template #default="{ requestClose, titleId }">
      <section class="modal" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header class="modal-header">
          <h2 :id="titleId">{{ tr('快捷键', 'Keyboard shortcuts') }}</h2>
          <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭快捷键', 'Close shortcuts')" @click="requestClose"><X :size="19" /></NButton>
        </header>
        <div class="modal-body shortcut-groups">
          <section v-for="group in groups" :key="group.en">
            <h3>{{ tr(group.zh, group.en) }}</h3>
            <dl class="shortcuts">
              <template v-for="[zh, en, key] in group.items" :key="en">
                <dt>{{ tr(zh, en) }}</dt><dd><kbd>{{ key }}</kbd></dd>
              </template>
            </dl>
          </section>
        </div>
      </section>
    </template>
  </WorkspaceDialog>
</template>
