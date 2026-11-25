import { createApp, h, ref } from 'vue'
import { NConfigProvider } from 'naive-ui'
import WorkspaceDialog from '../src/WorkspaceDialog.vue'

createApp({
  components: { NConfigProvider, WorkspaceDialog },
  setup() {
    const open = ref(false)
    const busy = ref(false)
    const dismissible = ref(true)
    const customTitle = ref(true)
    const closeCount = ref(0)

    function close() {
      closeCount.value++
      open.value = false
    }

    // The native mask intentionally blocks pointer access to controls behind it.
    window.dialogFixture = {
      setBusy: value => { busy.value = value },
      setDismissible: value => { dismissible.value = value },
      setCustomTitle: value => { customTitle.value = value },
    }

    return () => h(NConfigProvider, null, {
      default: () => [
        h('button', { id: 'opener', type: 'button', onClick: () => { open.value = true } }, 'Open dialog'),
        h('output', { id: 'close-count' }, String(closeCount.value)),
        h('div', { id: 'overlay-host' }),
        open.value ? h(WorkspaceDialog, {
          titleId: customTitle.value ? 'contract-title' : undefined,
          descriptionId: 'contract-description',
          busy: busy.value,
          dismissible: dismissible.value,
          onClose: close,
        }, {
          default: ({ requestClose, closeDisabled, titleId }) => h('section', { class: 'modal' }, [
            h('header', [h('h2', { id: customTitle.value ? 'contract-title' : titleId }, 'Contract dialog')]),
            h('p', { id: 'contract-description' }, 'A local dialog contract fixture.'),
            h('button', { id: 'before-autofocus', type: 'button' }, 'Before autofocus'),
            h('label', ['First field', h('input', { autofocus: true })]),
            h('button', { id: 'secondary', type: 'button' }, 'Secondary action'),
            h('button', {
              id: 'close',
              type: 'button',
              disabled: closeDisabled,
              onClick: () => requestClose(),
            }, 'Close contract'),
          ]),
        }) : null,
      ],
    })
  },
}).mount('#app')
