import { createApp } from 'vue'
import { NAlert, NButton, NCard, NInput, NRadioButton, NRadioGroup, NSwitch, NTable, NTag } from 'naive-ui'
import App from './App.vue'
import WorkspaceDialog from './WorkspaceDialog.vue'
import './style.css'

/* Mount the desktop workspace after Vite has loaded the Vue entry point. */
const app = createApp(App)
for (const [name, component] of Object.entries({
  NAlert, NButton, NCard, NInput, NRadioButton, NRadioGroup, NSwitch, NTable, NTag, WorkspaceDialog,
})) {
  app.component(name, component)
}
app.mount('#app')
