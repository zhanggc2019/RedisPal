<script setup>
import { computed, inject, ref } from 'vue'
import { Check, Palette, SlidersHorizontal, X } from '@lucide/vue'
import { themePresets } from '../theme.js'

defineProps({ settings: Object, palette: String, keyPageSizes: Array })
const emit = defineEmits(['close'])
const tr = inject('tr')
const selected = ref('appearance')
const interfaceFonts = [
  { family: 'Segoe UI', zh: 'Segoe UI' },
  { family: 'Microsoft YaHei UI', zh: '微软雅黑 UI' },
  { family: 'Microsoft YaHei', zh: '微软雅黑' },
  { family: 'SimSun', zh: '宋体' },
  { family: 'Arial', zh: 'Arial' },
]
const sections = computed(() => [
  { id: 'appearance', label: tr('外观', 'Appearance'), icon: Palette },
  { id: 'general', label: tr('常规', 'General'), icon: SlidersHorizontal },
])
const sectionTitle = computed(() => sections.value.find(section => section.id === selected.value)?.label)
</script>

<template>
  <WorkspaceDialog title-id="settings-title" @close="emit('close')">
    <template #default="{ requestClose, titleId }">
      <section class="modal settings-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header class="modal-header">
          <h2 :id="titleId">{{ tr('设置', 'Settings') }}</h2>
          <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭设置', 'Close settings')" @click="requestClose"><X :size="19" /></NButton>
        </header>
        <div class="settings-layout">
          <nav :aria-label="tr('设置分类', 'Settings categories')">
            <NButton v-for="section in sections" :key="section.id" size="small" quaternary class="flat"
              :aria-current="selected === section.id ? 'true' : undefined" @click="selected = section.id">
              <component :is="section.icon" :size="15" aria-hidden="true" />{{ section.label }}
            </NButton>
          </nav>
          <section :key="selected" class="settings-page" aria-labelledby="settings-section-title">
            <h3 id="settings-section-title">{{ sectionTitle }}</h3>
            <template v-if="selected === 'appearance'">
              <label class="settings-row">
                <span>{{ tr('主题', 'Theme') }}</span>
                <select v-model="settings.theme"><option value="system">{{ tr('跟随系统', 'System') }}</option><option value="light">{{ tr('浅色', 'Light') }}</option><option value="dark">{{ tr('深色', 'Dark') }}</option></select>
              </label>
              <fieldset class="preset-picker">
                <legend>{{ tr('配色方案', 'Color scheme') }}</legend>
                <NRadioGroup v-model:value="settings.scheme" name="color-scheme" :aria-label="tr('配色方案', 'Color scheme')" class="preset-options">
                  <NRadioButton v-for="preset in themePresets" :key="preset.id" :value="preset.id">
                    <span class="preset-option" :title="tr(preset.zh, preset.en)">
                      <Check v-if="settings.scheme === preset.id" class="preset-check" :size="13" aria-hidden="true" />
                      <i v-else aria-hidden="true" :style="{ background: preset[palette] }"></i><span>{{ tr(preset.zh, preset.en) }}</span>
                    </span>
                  </NRadioButton>
                </NRadioGroup>
              </fieldset>
              <section class="settings-group" aria-labelledby="settings-display-title">
                <h4 id="settings-display-title">{{ tr('显示', 'Display') }}</h4>
                <div class="form-grid">
                  <label>{{ tr('界面缩放', 'Interface zoom') }}<select v-model.number="settings.zoom"><option v-for="zoom in [85, 90, 100, 110, 120, 125, 130, 150]" :key="zoom" :value="zoom">{{ zoom }}%</option></select></label>
                  <label>{{ tr('界面字体', 'Interface font') }}
                    <select v-model="settings.font">
                      <option value="">{{ tr('系统默认', 'System default') }}</option>
                      <option v-for="font in interfaceFonts" :key="font.family" :value="font.family">{{ tr(font.zh, font.family) }}</option>
                      <option v-if="settings.font && !interfaceFonts.some(font => font.family === settings.font)" :value="settings.font">{{ settings.font }}</option>
                    </select>
                  </label>
                </div>
              </section>
            </template>
            <template v-else>
              <label class="settings-row"><span>{{ tr('语言', 'Language') }}</span><select v-model="settings.language"><option value="zh">简体中文</option><option value="en">English</option></select></label>
              <label class="settings-row"><span>{{ tr('每批加载键数', 'Keys per batch') }}</span><select v-model.number="settings.keyPageSize"><option v-for="count in keyPageSizes" :key="count" :value="count">{{ count.toLocaleString(settings.language === 'en' ? 'en-US' : 'zh-CN') }}</option></select></label>
            </template>
          </section>
        </div>
        <footer class="modal-footer settings-footer">
          <span>{{ tr('更改即时生效', 'Changes take effect immediately') }}</span>
          <NButton size="small" @click="requestClose">{{ tr('关闭', 'Close') }}</NButton>
        </footer>
      </section>
    </template>
  </WorkspaceDialog>
</template>
