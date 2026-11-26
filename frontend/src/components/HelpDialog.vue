<script setup>
import { computed, inject } from 'vue'
import { ExternalLink, X } from '@lucide/vue'
import { Browser } from '../api.js'
import ReleaseNotes from './ReleaseNotes.vue'
import StatusNotice from './StatusNotice.vue'

const props = defineProps({
  section: String, release: Object, availableUpdate: Object, updateFeedback: Object,
  updateTitle: String, updateAction: String, checking: Boolean, updating: Boolean,
})
const emit = defineEmits(['close', 'check', 'apply-update', 'dismiss-update', 'defer-restart'])
const tr = inject('tr')

/** Match the dialog heading to the command selected in Help. */
const title = computed(() => {
  if (props.section === 'about') return tr('关于 RedisPal', 'About RedisPal')
  if (props.section === 'updates') return tr('检查更新', 'Check for updates')
  return tr('使用帮助', 'User guide')
})
/** Keep the check button's accessible name independent of the loading icon. */
const checkLabel = computed(() => props.checking ? tr('正在检查…', 'Checking…') : title.value)

const guide = [
  ['连接 Redis', 'Connect to Redis', '在侧栏点「新建连接」，输入 Redis 地址和所需的认证信息。测试并保存后，点连接名称打开它。', 'Choose New connection in the sidebar and enter the Redis address and credentials. Test and save it, then select its name to connect.'],
  ['浏览和编辑键', 'Browse and edit keys', '选择数据库后，可搜索键名或浏览键树。打开键即可查看数据类型、值和 TTL。在可写连接中也可以修改值或 TTL。', 'Choose a database to browse the key tree or search by name. Open a key to view its type, value, and TTL. A writable connection lets you change the value or TTL.'],
  ['使用数据库工具', 'Use database tools', '连接后，切换侧栏的「工具」即可打开 Redis CLI、服务器概览、实时监控等工具。', 'Switch to Tools in the sidebar to open Redis CLI, Server overview, Profiler, and other tools.'],
]
</script>

<template>
  <WorkspaceDialog title-id="help-title" :busy="section === 'updates' && updating" @close="emit('close')">
    <template #default="{ requestClose, closeDisabled, titleId }">
      <section class="modal help-dialog" :class="{ 'small-modal': section === 'about' }" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header class="modal-header">
          <h2 :id="titleId">{{ title }}</h2>
          <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭窗口', 'Close dialog')" :disabled="closeDisabled" @click="requestClose"><X :size="19" /></NButton>
        </header>
        <div v-if="section === 'guide'" class="modal-body help-content">
          <section v-for="[zhTitle, enTitle, zhText, enText] in guide" :key="enTitle" class="help-topic">
            <h3>{{ tr(zhTitle, enTitle) }}</h3>
            <p>{{ tr(zhText, enText) }}</p>
          </section>
          <a v-if="release.repositoryUrl" class="help-link" :href="release.repositoryUrl + '#readme'" @click.prevent="Browser.OpenURL(release.repositoryUrl + '#readme')">
            {{ tr('项目文档', 'Project documentation') }}<ExternalLink :size="14" aria-hidden="true" />
          </a>
        </div>
        <div v-else-if="section === 'about'" class="modal-body help-content">
          <div class="about-product">
            <img src="/logo.png" class="app-logo" width="48" height="48" alt="">
            <div>
              <strong v-if="release.version">{{ tr('版本', 'Version') }} {{ release.version }}</strong>
              <p>{{ tr('用于浏览和管理 Redis 数据的桌面客户端。', 'A desktop client for browsing and managing Redis data.') }}</p>
            </div>
          </div>
          <ReleaseNotes :notes="release.notes" />
          <a v-if="release.repositoryUrl" class="help-link" :href="release.repositoryUrl" @click.prevent="Browser.OpenURL(release.repositoryUrl)">
            {{ tr('GitHub 仓库', 'GitHub repository') }}<ExternalLink :size="14" aria-hidden="true" />
          </a>
        </div>
        <div v-else class="modal-body help-content">
          <div class="update-version">
            <span>{{ tr('当前版本', 'Current version') }} <strong>{{ release.version }}</strong></span>
            <NButton v-if="release.github || release.signed" size="small" :loading="checking" :disabled="checking || updating"
              :aria-label="checkLabel" @click="emit('check')">
              {{ checkLabel }}
            </NButton>
          </div>
          <StatusNotice v-if="!release.github && !release.signed" tone="info" :title="tr('此构建未配置更新源', 'This build has no update source configured')" />
          <StatusNotice v-if="updateFeedback" :tone="updateFeedback.error ? 'error' : 'success'" :title="updateFeedback.text" />
          <div v-if="availableUpdate" class="update-available">
            <div role="status" aria-atomic="true"><strong>{{ updateTitle }}</strong><span>{{ availableUpdate.version }}</span></div>
            <div class="update-actions">
              <NButton v-if="availableUpdate.ready" size="small" quaternary :disabled="updating" @click="emit('defer-restart')">{{ tr('稍后', 'Later') }}</NButton>
              <NButton v-else size="small" quaternary :disabled="checking || updating" @click="emit('dismiss-update')">{{ tr('忽略此版本', 'Ignore this version') }}</NButton>
              <NButton type="primary" size="small" :disabled="checking || updating" :loading="updating" @click="emit('apply-update')">{{ updateAction }}</NButton>
            </div>
          </div>
          <ReleaseNotes :notes="availableUpdate ? availableUpdate.notes : release.notes" />
        </div>
        <footer class="modal-footer end"><NButton size="small" :disabled="closeDisabled" @click="requestClose">{{ tr('关闭', 'Close') }}</NButton></footer>
      </section>
    </template>
  </WorkspaceDialog>
</template>
