<script setup>
import { computed, inject, ref } from 'vue'
import { X } from '@lucide/vue'
import { Browser } from '../api.js'
import { themePresets } from '../theme.js'

const props = defineProps({ settings: Object, palette: String, keyPageSizes: Array, release: Object, checking: Boolean })
const emit = defineEmits(['close', 'check'])
const tr = inject('tr')
const selected = ref('appearance')
const sections = computed(() => [
  { id: 'appearance', label: tr('外观', 'Appearance') },
  { id: 'general', label: tr('常规', 'General') },
  ...(props.release.version ? [{ id: 'updates', label: tr('更新', 'Updates') }] : []),
])
</script>

<template>
  <WorkspaceDialog title-id="settings-title" :busy="checking" @close="emit('close')">
    <template #default="{ requestClose, closeDisabled, titleId }">
      <section class="modal settings-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header class="modal-header">
          <h2 :id="titleId">{{ tr('设置', 'Settings') }}</h2>
          <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭设置', 'Close settings')" :disabled="closeDisabled" @click="requestClose"><X :size="19" /></NButton>
        </header>
        <div class="settings-layout">
          <nav :aria-label="tr('设置分类', 'Settings categories')">
            <NButton v-for="section in sections" :key="section.id" size="small" :secondary="selected === section.id"
              :quaternary="selected !== section.id" :aria-current="selected === section.id ? 'true' : undefined" @click="selected = section.id">
              {{ section.label }}
            </NButton>
          </nav>
          <div v-if="selected === 'appearance'" class="modal-body form-grid">
            <fieldset class="preset-picker">
              <legend>{{ tr('配色方案', 'Color scheme') }}</legend>
              <NRadioGroup v-model:value="settings.scheme" name="color-scheme" :aria-label="tr('配色方案', 'Color scheme')" class="preset-options">
                <NRadioButton v-for="preset in themePresets" :key="preset.id" :value="preset.id">
                  <span class="preset-option"><i aria-hidden="true" :style="{ background: preset[palette] }"></i>{{ tr(preset.zh, preset.en) }}</span>
                </NRadioButton>
              </NRadioGroup>
            </fieldset>
            <label>{{ tr('主题', 'Theme') }}<select v-model="settings.theme"><option value="system">{{ tr('跟随系统', 'System') }}</option><option value="light">{{ tr('浅色', 'Light') }}</option><option value="dark">{{ tr('深色', 'Dark') }}</option></select></label>
            <label>{{ tr('界面缩放', 'Interface zoom') }}<select v-model.number="settings.zoom"><option v-for="zoom in [85, 90, 100, 110, 120, 125, 130, 150]" :key="zoom" :value="zoom">{{ zoom }}%</option></select></label>
            <label><span id="workspace-font-label">{{ tr('界面字体', 'Interface font') }}</span>
              <NInput v-model:value="settings.font" :placeholder="tr('系统默认', 'System default')" :input-props="{ 'aria-labelledby': 'workspace-font-label' }" />
            </label>
          </div>
          <div v-else-if="selected === 'general'" class="modal-body form-grid">
            <label>{{ tr('语言', 'Language') }}<select v-model="settings.language"><option value="zh">简体中文</option><option value="en">English</option></select></label>
            <label>{{ tr('每批加载键数', 'Keys per batch') }}<select v-model.number="settings.keyPageSize"><option v-for="count in keyPageSizes" :key="count" :value="count">{{ count }}</option></select></label>
          </div>
          <div v-else class="modal-body update-settings">
            <span>{{ tr('当前版本', 'Current version') }} <strong>{{ release.version }}</strong></span>
            <NButton v-if="release.github" size="small" :disabled="checking" @click="emit('check')">
              {{ checking ? tr('正在检查…', 'Checking…') : tr('检查更新', 'Check for updates') }}
            </NButton>
            <div v-if="release.repositoryUrl" class="repository-row">
              <a class="repository-link" :href="release.repositoryUrl" @click.prevent="Browser.OpenURL(release.repositoryUrl)">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
                {{ release.repositoryUrl }}
              </a>
            </div>
          </div>
        </div>
        <footer class="modal-footer end"><NButton size="small" :disabled="closeDisabled" @click="requestClose">{{ tr('完成', 'Done') }}</NButton></footer>
      </section>
    </template>
  </WorkspaceDialog>
</template>
