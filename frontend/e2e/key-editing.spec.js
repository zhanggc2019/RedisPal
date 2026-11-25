import { fileURLToPath } from 'node:url'
import { chromium, expect, test } from '@playwright/test'
import { createServer } from 'vite'

const fixtureModule = '/key-panel-fixture.js'
const fixture = `
import { createApp, h, reactive } from 'vue'
import { NButton, NInput, NSwitch, NTable, NTag } from 'naive-ui'
import KeyPanel from '/src/KeyPanel.vue'
import WorkspaceDialog from '/src/WorkspaceDialog.vue'
const state = window.fixture
const tab = reactive({ id: 'key', kind: state.kind, connection: 'fixture', db: 4, key: state.key })
const app = createApp({ render: () => h(KeyPanel, {
  tab, visible: true, connection: { name: 'Fixture', readOnly: state.readOnly },
  onDirty: dirty => { tab.dirty = dirty; state.dirty = dirty },
  onChange: key => state.changes.push(key),
}) })
for (const [name, component] of Object.entries({ NButton, NInput, NSwitch, NTable, NTag, WorkspaceDialog })) {
  app.component(name, component)
}
app.provide('tr', (_zh, en) => en)
app.provide('notify', () => {})
app.provide('ask', async () => true)
app.provide('confirmDiscard', async tabs => {
  state.confirmations.push(tabs.map(tab => tab.id))
  return state.discard
})
app.mount('#app')
`
const mockAPI = `
export function command(id, db, ...args) {
  if (id !== 'fixture' || db !== 4) throw new Error('Unexpected connection or DB')
  return window.fixture.run(args)
}
export function call() { throw new Error('Unexpected service call') }
export const Clipboard = { SetText: async () => {} }
`

let server
let browser
let origin

test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, watch: null },
    plugins: [{
      name: 'key-panel-fixture',
      enforce: 'pre',
      resolveId(id) {
        if (id === fixtureModule) return '\0key-panel-fixture'
        if (id === './api.js') return '\0key-panel-api'
      },
      load(id) {
        if (id === '\0key-panel-fixture') return fixture
        if (id === '\0key-panel-api') return mockAPI
      },
    }],
  })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
})

test.afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open({ kind = 'key', type = 'string', value = 'original', readOnly = false, key = 'example', failures = {} } = {}) {
  const page = await browser.newPage()
  await page.addInitScript(({ kind, type, value, readOnly, key, failures }) => {
    const state = window.fixture = { kind, type, value, readOnly, key, failures, calls: [], changes: [], confirmations: [], ttl: 30, discard: false }
    const replies = { HLEN: 1, HSCAN: ['0', [{ hex: 'ff' }, 'old entry']], HTTL: [120] }
    state.run = async ([command, ...args]) => {
      state.calls.push([command, ...args])
      if (state.failures[command]) throw new Error(state.failures[command])
      switch (command) {
        case 'TYPE': return state.type
        case 'TTL': return state.type === 'none' ? -2 : state.ttl
        case 'MEMORY': return 123
        case 'GET': return state.value
        case 'SET':
          if (state.pauseWrite) await new Promise(resolve => { state.finishWrite = resolve })
          state.value = args[1]
          return 'OK'
        case 'EXPIRE':
          if (state.pauseWrite) await new Promise(resolve => { state.finishWrite = resolve })
          state.ttl = args[1]
          return 1
        case 'DEL':
          state.type = 'none'
          return 1
        default:
          if (command in replies) return replies[command]
          throw new Error(`Unexpected command ${command}`)
      }
    }
  }, { kind, type, value, readOnly, key, failures })
  await page.route(`${origin}/`, route => route.fulfill({
    contentType: 'text/html',
    body: `<div id="app"></div><div id="overlay-host"></div><script type="module" src="${fixtureModule}"></script>`,
  }))
  await page.goto(origin)
  return page
}

const valueInput = page => page.getByRole('textbox', { name: 'Value', exact: true })
const saveValue = page => page.getByRole('button', { name: 'Save value', exact: true })
const refreshKey = page => page.getByRole('button', { name: 'Refresh key', exact: true })
const dirty = page => page.evaluate(() => window.fixture.dirty)

test('retains exact binary drafts across formats and failed saves or refreshes', async () => {
  const page = await open({ value: { hex: 'ff00' }, key: { hex: 'fe' } })
  try {
    const value = valueInput(page)
    const format = page.getByLabel('Value format')
    await expect(value).toHaveValue('ff 00')
    await value.fill('ff aa')
    await format.selectOption('Text')
    await expect(value).toHaveValue('\ufffd\ufffd')
    await format.selectOption('Hex')
    await expect(value).toHaveValue('ff aa')
    expect(await dirty(page)).toBe(true)
    await page.evaluate(() => { window.fixture.failures.SET = 'Write rejected' })
    await saveValue(page).click()
    await expect(page.getByRole('alert')).toHaveText('Write rejected')
    expect(await dirty(page)).toBe(true)
    await page.evaluate(() => { window.fixture.failures.GET = 'Read rejected'; window.fixture.ttl = 99 })
    await refreshKey(page).click()
    await expect(page.getByText('Data may be stale')).toBeVisible()
    await expect(page.getByLabel('TTL', { exact: true })).toHaveValue('30')
    await expect(value).toHaveValue('ff aa')
    await expect(saveValue(page)).toBeDisabled()
    await page.evaluate(() => { window.fixture.failures = {} })
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(saveValue(page)).toBeEnabled()
    await saveValue(page).click()
    await expect.poll(() => dirty(page)).toBe(false)
    expect(await page.evaluate(() => window.fixture.calls.filter(([name]) => name === 'SET').at(-1)))
      .toEqual(['SET', { hex: 'fe' }, { hex: 'ffaa' }, 'XX', 'KEEPTTL'])
  } finally {
    await page.close()
  }
})

test('preserves edits made while value and TTL writes are pending', async () => {
  const page = await open()
  try {
    const value = valueInput(page)
    const ttl = page.getByLabel('TTL', { exact: true })
    await expect(value).toHaveValue('original')
    await value.fill('submitted')
    await page.evaluate(() => { window.fixture.pauseWrite = true })
    await saveValue(page).click()
    await expect(saveValue(page)).toBeDisabled()
    await value.fill('original')
    expect(await dirty(page)).toBe(true)
    await page.evaluate(() => window.fixture.finishWrite())
    await expect(saveValue(page)).toBeEnabled()
    await expect(value).toHaveValue('original')
    expect(await dirty(page)).toBe(true)
    await value.fill('submitted')
    await expect.poll(() => dirty(page)).toBe(false)
    await ttl.fill('60')
    const updateTTL = page.getByRole('button', { name: 'Update TTL' })
    await updateTTL.click()
    await ttl.fill('30')
    await page.evaluate(() => window.fixture.finishWrite())
    await expect(updateTTL).toBeEnabled()
    await expect(ttl).toHaveValue('30')
    expect(await dirty(page)).toBe(true)
  } finally {
    await page.close()
  }
})

test('clears the submitted draft when the write succeeds but its refresh fails', async () => {
  const page = await open()
  try {
    const value = valueInput(page)
    await expect(value).toHaveValue('original')
    await value.fill('submitted')
    await page.evaluate(() => { window.fixture.failures.GET = 'Read rejected' })
    await saveValue(page).click()
    await expect(page.getByText('Data may be stale')).toBeVisible()
    await expect(value).toHaveValue('submitted')
    await expect(saveValue(page)).toBeDisabled()
    expect(await dirty(page)).toBe(false)
    await page.evaluate(() => {
      window.fixture.failures = {}
      window.fixture.value = 'original'
    })
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(value).toHaveValue('original')
    await expect(saveValue(page)).toBeEnabled()
  } finally {
    await page.close()
  }
})

test('keeps cached collection rows and gates stale mutations after a late read failure', async () => {
  const page = await open({ type: 'hash' })
  try {
    await expect(page.getByText('old entry')).toBeVisible()
    const lastRead = await page.locator('time').getAttribute('datetime')
    await page.evaluate(() => { window.fixture.failures.HSCAN = 'Collection read rejected' })
    await refreshKey(page).click()
    await expect(page.getByText('Data may be stale')).toBeVisible()
    await expect(page.getByText('old entry')).toBeVisible()
    await expect(page.locator('time')).toHaveAttribute('datetime', lastRead)
    await expect(page.getByRole('button', { name: 'Add entry' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Rename key' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Delete entry' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Field TTL', exact: true })).toBeDisabled()
  } finally {
    await page.close()
  }
})

test('offers retry on the first read failure and keeps a draft if the key disappears', async () => {
  const page = await open({ failures: { TYPE: 'Type read rejected' } })
  try {
    await expect(page.getByRole('alert')).toHaveText(/Type read rejected/)
    await expect(valueInput(page)).toHaveCount(0)
    await page.evaluate(() => { window.fixture.failures = {} })
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(valueInput(page)).toHaveValue('original')
    await valueInput(page).fill('keep this draft')
    await page.evaluate(() => { window.fixture.type = 'none' })
    await refreshKey(page).click()
    await expect(page.getByText('This key is missing or expired.')).toBeVisible()
    await expect(valueInput(page)).toHaveValue('keep this draft')
    await expect(valueInput(page)).not.toBeEditable()
    await expect(saveValue(page)).toHaveCount(0)
    expect(await dirty(page)).toBe(true)
    await page.evaluate(() => { window.fixture.type = 'string' })
    await refreshKey(page).click()
    await expect(saveValue(page)).toBeEnabled()
    await expect(valueInput(page)).toHaveValue('keep this draft')
  } finally {
    await page.close()
  }
})

test('only discards a draft after a confirmed delete succeeds', async () => {
  const page = await open()
  try {
    const value = valueInput(page)
    const remove = page.getByRole('button', { name: 'Delete key' })
    await expect(value).toBeEditable()
    await value.fill('keep this draft')
    await remove.click()
    await expect(remove).toBeEnabled()
    await expect(value).toHaveValue('keep this draft')
    expect(await page.evaluate(() => window.fixture.calls.some(([name]) => name === 'DEL'))).toBe(false)
    await page.evaluate(() => {
      window.fixture.discard = true
      window.fixture.failures.DEL = 'Delete rejected'
    })
    await remove.click()
    await expect(page.getByRole('alert')).toHaveText('Delete rejected')
    expect(await dirty(page)).toBe(true)
    await page.evaluate(() => { window.fixture.failures = {} })
    await remove.click()
    await expect.poll(() => page.evaluate(() => window.fixture.changes.length)).toBe(1)
    expect(await dirty(page)).toBe(false)
  } finally {
    await page.close()
  }
})

test('guards a modified collection row when the dialog closes', async () => {
  const page = await open({ type: 'hash' })
  try {
    await page.getByRole('button', { name: 'Edit entry' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit entry' })
    const value = dialog.getByRole('textbox', { name: 'Value', exact: true })
    await expect(value).toHaveValue('old entry')
    await value.fill('new draft')
    await value.press('Escape')
    await expect(value).toHaveValue('new draft')
    expect(await dirty(page)).toBe(true)
    expect(await page.evaluate(() => window.fixture.confirmations)).toEqual([['key']])
    await page.evaluate(() => { window.fixture.discard = true })
    await value.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await dirty(page)).toBe(false)
  } finally {
    await page.close()
  }
})

test('shows field TTL on read-only connections using the original field bytes', async () => {
  const page = await open({ type: 'hash', readOnly: true })
  try {
    await page.getByRole('button', { name: 'View field TTL' }).click()
    await expect(page.getByRole('dialog', { name: 'View field TTL' })).toContainText('120')
    const calls = await page.evaluate(() => window.fixture.calls)
    expect(calls.at(-1)).toEqual(['HTTL', 'example', 'FIELDS', 1, { hex: 'ff' }])
  } finally {
    await page.close()
  }
})

test('guards new-key type changes and keeps common fields after confirmation', async () => {
  const page = await open({ kind: 'new' })
  try {
    const value = valueInput(page)
    const type = page.getByLabel('Data type')
    const name = page.getByLabel('Key name', { exact: true })
    await expect(value).toBeEditable()
    await name.fill('new name')
    await value.fill('draft')
    await type.selectOption('hash')
    await expect(type).toHaveValue('string')
    await expect(value).toHaveValue('draft')
    expect(await page.evaluate(() => window.fixture.confirmations)).toEqual([['key']])
    await page.evaluate(() => { window.fixture.discard = true })
    await type.selectOption('hash')
    await expect(type).toHaveValue('hash')
    await expect(value).toHaveValue('')
    await expect(name).toHaveValue('new name')
    await type.selectOption('string')
    await name.fill('')
    await expect.poll(() => dirty(page)).toBe(false)
  } finally {
    await page.close()
  }
})
