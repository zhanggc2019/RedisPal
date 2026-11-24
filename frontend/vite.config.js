import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  css: { postcss: { plugins: [] } },
  build: {
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'naive-ui', test: /node_modules[/\\]naive-ui[/\\]/ }] } },
    },
  },
})
