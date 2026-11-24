import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHTTPServer } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { chromium, expect, test } from '@playwright/test'

const addr = process.env.REDIS_TEST_ADDR
const password = process.env.REDIS_TEST_PASSWORD || ''

/** Allocate a loopback-only CDP port for the isolated desktop test profile. */
async function port() {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const number = server.address().port
  await new Promise(resolve => server.close(resolve))
  return number
}

/** Attach Playwright to the actual WebView2 instance and its Wails bindings. */
async function launch(updateURL = '') {
  const profile = await mkdtemp(join(tmpdir(), 'ardm-wails-e2e-'))
  const cdp = await port()
  const exe = process.env.ARDM_TEST_EXE || join(process.cwd(), '..', 'bin', 'RedisPal-test.exe')
  const processHandle = spawn(exe, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ARDM_WEBVIEW_PROFILE: profile,
      ARDM_TEST_CDP_PORT: String(cdp),
      ARDM_TEST_UPDATE_URL: updateURL,
    },
  })
  let spawnError
  processHandle.on('error', error => { spawnError = error })
  let browser
  let connectionError
  try {
    for (let i = 0; i < 30; i++) {
      if (spawnError) throw spawnError
      if (processHandle.exitCode !== null) throw new Error('Desktop app exited with ' + processHandle.exitCode)
      try {
        const base = 'http://127.0.0.1:' + cdp
        browser = await chromium.connectOverCDP(base, { timeout: 1000 })
        break
      } catch (error) {
        connectionError = error
        await setTimeout(250)
      }
    }
    if (!browser) throw new Error('Cannot attach to WebView2: ' + connectionError?.message)
    const context = browser.contexts()[0]
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 8_000 })
    await page.waitForLoadState('domcontentloaded')
    return {
      page,
      release: async () => {
        await browser.close().catch(() => {})
        processHandle.kill()
        await rm(profile, { force: true, recursive: true, maxRetries: 10, retryDelay: 250 }).catch(() => {})
      },
    }
  } catch (error) {
    if (browser) await browser.close().catch(() => {})
    processHandle.kill()
    await rm(profile, { force: true, recursive: true, maxRetries: 8, retryDelay: 250 }).catch(() => {})
    throw error
  }
}

/** Create and verify a saved connection using normal desktop form controls. */
async function connect(page, name, readOnly = false, endpoint = addr, secret = password) {
  const add = page.getByRole('button', { name: 'New connection', exact: true }).first()
  await add.click()
  const dialog = page.getByRole('dialog', { name: '', exact: true })
  await dialog.getByText('Connection name', { exact: true }).locator('input').fill(name)
  await dialog.getByLabel('Address', { exact: true }).fill(endpoint)
  await dialog.getByLabel('Password', { exact: true }).fill(secret)
  if (readOnly) await dialog.getByLabel('Read-only').check()
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  const result = dialog.getByRole('status')
  await expect(result).toContainText('Connection successful')
  await expect(result).toContainText(endpoint)
  await expect(result).toHaveClass(/\bsuccess\b/)
  await expect(result).toBeInViewport()
  await dialog.getByRole('button', { name: 'Save connection' }).click()
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Connection successful · ' + name)
  await expect(page.getByLabel('Database', { exact: true })).toBeVisible()
}

/** Run one command in the visible Redis CLI tab. */
async function cli(page, line) {
  const input = page.getByLabel('Redis command')
  await input.fill(line)
  await input.press('Enter')
  await expect(page.getByRole('log')).toContainText(line)
}

/** Remove only fixture keys even if the UI failed before the CLI could open. */
async function cleanup(endpoint, secret, ...keys) {
  const url = new URL('redis://' + endpoint)
  const commands = [...(secret ? [['AUTH', secret]] : []), ['DEL', ...keys]]
  const payload = commands.map(args => '*' + args.length + '\r\n' + args.map(arg => '$' + Buffer.byteLength(arg) + '\r\n' + arg + '\r\n').join('')).join('')
  await new Promise(resolve => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 6379) })
    let received = ''
    socket.setTimeout(1500, () => socket.destroy())
    socket.once('connect', () => socket.write(payload))
    socket.on('data', data => {
      received += data.toString()
      if (received.split('\r\n').length > commands.length) socket.end()
    })
    socket.once('error', resolve)
    socket.once('close', resolve)
  })
}

/** Set the persisted test language using the same Settings UI as a user. */
async function english(page) {
  page.setDefaultTimeout(8_000)
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).click()
  await page.getByRole('combobox', { name: /^(语言|Language)$/ }).selectOption('en')
  await page.getByRole('dialog').getByRole('button', { name: /^(关闭设置|Close settings)$/ }).click()
}

/** Exercise startup polling and the manual update action against a local GitHub response fixture. */
test('desktop finds a new release automatically and offers its download page', async () => {
  test.skip(process.platform !== 'win32', 'requires the native Windows build')
  let checks = 0
  const server = createHTTPServer((_request, response) => {
    checks++
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ tag_name: 'v0.0.2' }))
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  let app
  try {
    app = await launch('http://127.0.0.1:' + server.address().port)
    const { page } = app
    const status = page.getByRole('status')
    await expect(status).toContainText('发现新版本')
    await expect(status).toContainText('v0.0.1 → v0.0.2')
    await expect(page.getByRole('button', { name: '查看并下载' })).toBeVisible()
    await page.getByRole('button', { name: '关闭更新提示' }).click()
    await expect(status).toHaveCount(0)
    await page.reload()
    await expect.poll(() => checks).toBe(2)
    await expect(status).toHaveCount(0)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('当前版本 v0.0.1')
    await page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(status).toContainText('v0.0.2')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    if (app) await app.release()
    await new Promise(resolve => server.close(resolve))
  }
})

/** Check that primary actions use the logo's green palette with legible button text. */
test('desktop themes use green primary actions with readable text', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'requires the native Windows build')
  const app = await launch()
  const { page } = app
  try {
    const root = page.locator('.app')
    const primary = page.getByRole('button', { name: '新建连接', exact: true }).first()
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('combobox', { name: '主题', exact: true }).selectOption(theme)
      await dialog.getByRole('button', { name: '关闭设置', exact: true }).click()
      await expect(root).toHaveAttribute('data-theme', theme)
      const [background, foreground] = await primary.evaluate(button => {
        const style = getComputedStyle(button)
        return [style.backgroundColor, style.color].map(color => color.match(/\d+/g).slice(0, 3).map(Number))
      })
      const [red, green, blue] = background
      expect(green).toBeGreaterThan(Math.max(red, blue))
      const colors = [background, foreground].map(rgb => rgb.map(channel => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0))
      expect((Math.max(...colors) + 0.05) / (Math.min(...colors) + 0.05)).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: info.outputPath(theme + '-theme.png') })
    }
  } finally {
    await app.release()
  }
})

test('desktop app creates, edits, searches, backs up, restores and deletes Redis keys', async ({}, info) => {
  test.skip(!addr || process.platform !== 'win32', 'set REDIS_TEST_ADDR on Windows for the native test')
  const app = await launch()
  const { page } = app
  const key = 'ardm-wails-e2e:' + Date.now()
  const hash = key + ':hash'
  const runtimeErrors = []
  page.on('pageerror', error => runtimeErrors.push(error.message))
  try {
    page.setDefaultTimeout(8_000)
    await expect(page).toHaveTitle('RedisPal')
    await expect(page.getByRole('heading', { name: 'RedisPal', exact: true })).toBeVisible()
    await expect(page.locator('.home-logo')).toHaveJSProperty('naturalWidth', 512)
    await page.screenshot({ path: info.outputPath('startup-logo.png') })
    await expect(page.getByRole('button', { name: '新建连接', exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const language = page.getByRole('combobox', { name: '语言', exact: true })
    await expect(language).toHaveValue('zh')
    await expect(language.getByRole('option')).toHaveText(['简体中文', 'English'])
    await language.selectOption('en')
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Settings' })).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Close settings', exact: true }).click()
    // Seed an existing workspace with the storage key used before the rename.
    await page.evaluate(() => {
      const workspace = JSON.parse(localStorage.getItem('ardm-workspace-v1'))
      workspace.connections.push({ id: 'existing-profile', name: 'Existing Redis profile', addr: '127.0.0.1:6379' })
      localStorage.setItem('ardm-workspace-v1', JSON.stringify(workspace))
    })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Existing Redis profile', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New connection', exact: true }).first()).toBeVisible()
    await expect(page.getByRole('status')).toHaveCount(0)
    await connect(page, 'Wails Redis E2E')
    await page.screenshot({ path: info.outputPath('connection-success.png') })
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click()
    await expect(page.getByRole('status')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Wails Redis E2E' })).toBeVisible()
    await expect(page.getByText('Redis version')).toBeVisible()
    await page.getByRole('button', { name: 'New key', exact: true }).click()
    await page.getByLabel('Key name', { exact: true }).fill(key)
    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('original value')
    await page.getByRole('button', { name: 'Create key' }).click()
    await expect(page.getByRole('heading', { name: key, exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Value', exact: true })).toHaveValue('original value')

    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('updated value')
    await page.getByRole('button', { name: 'Save value' }).click()
    await expect(page.getByRole('status')).toContainText('Saved')
    await page.getByLabel('TTL', { exact: true }).fill('90')
    await page.getByRole('button', { name: 'Update TTL' }).click()
    await expect(page.getByRole('status')).toContainText('TTL updated')
    await page.getByLabel('Search keys', { exact: true }).fill(key)
    await page.getByLabel('Search keys', { exact: true }).press('Enter')
    await expect(page.locator('.keys-toolbar')).toContainText('1 keys')
    await page.getByRole('button', { name: 'Toggle tree/list' }).click()
    await expect(page.locator('.key-scroll').getByRole('button', { name: key, exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'New key', exact: true }).click()
    await page.getByLabel('Key name', { exact: true }).fill(hash)
    await page.getByRole('combobox', { name: 'Data type', exact: true }).selectOption('hash')
    await page.getByLabel('Field / element name').fill('field')
    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('value')
    await page.getByRole('button', { name: 'Create key' }).click()
    await expect(page.getByRole('heading', { name: hash, exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'field', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add entry' }).click()
    await page.getByRole('dialog').getByLabel('Field / element name').fill('second')
    await page.getByRole('dialog').getByLabel('Value', { exact: true }).fill('another value')
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('cell', { name: 'another value' })).toBeVisible()
    await page.getByTitle('Edit entry', { exact: true }).last().click()
    await page.getByRole('dialog').getByLabel('Value', { exact: true }).fill('changed entry')
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('cell', { name: 'changed entry' })).toBeVisible()

    await page.getByTitle('Open CLI', { exact: true }).click()
    await cli(page, 'GET ' + key)
    await expect(page.getByRole('log').getByText('updated value', { exact: true })).toBeVisible()
    await cli(page, 'PTTL ' + key)
    await expect(page.getByRole('log').locator('pre').last()).toHaveText(/^\d+$/)
    await page.getByRole('button', { name: 'Database actions' }).click()
    await page.getByRole('button', { name: 'Memory analysis', exact: true }).click()
    await page.getByPlaceholder('Key pattern, e.g. session:*').fill(key + '*')
    await page.getByRole('button', { name: 'Analyze', exact: true }).click()
    await expect(page.getByRole('cell', { name: hash, exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Database actions' }).click()
    await page.getByRole('button', { name: 'Command log', exact: true }).click()
    await expect(page.getByRole('cell', { name: 'GET', exact: true }).first()).toBeVisible()

    await page.getByRole('tab', { name: key, exact: true }).click()
    const [backup] = await Promise.all([
      page.waitForEvent('download', { timeout: 8_000 }),
      page.getByRole('button', { name: 'Export key', exact: true }).click(),
    ])
    const output = info.outputPath('key-backup.json')
    await backup.saveAs(output)
    await page.getByRole('button', { name: 'Delete key', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByRole('tab', { name: key, exact: true })).toHaveCount(0)
    await page.locator('input[accept=".json,.csv"]').setInputFiles(output)
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('status')).toContainText('Imported · 1')
    await page.getByRole('tab', { name: 'CLI · Wails Redis E2E', exact: true }).click()
    await cli(page, 'DEL ' + key + ' ' + hash)
    await expect(page.getByRole('log').locator('pre').last()).toHaveText('2')
    await page.screenshot({ path: info.outputPath('desktop-workspace.png') })
    expect(runtimeErrors).toEqual([])
  } finally {
    await cleanup(addr, password, key, hash)
    await app.release()
  }
})

test('desktop read-only settings prevent changes from both the browser and CLI', async ({}) => {
  test.skip(!addr || process.platform !== 'win32', 'set REDIS_TEST_ADDR on Windows')
  const app = await launch()
  const { page } = app
  const key = 'ardm-wails-readonly:' + Date.now()
  try {
    await english(page)
    await connect(page, 'Read-only Redis', true)
    await expect(page.getByRole('button', { name: 'New key', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Database actions' }).click()
    await expect(page.getByRole('button', { name: 'Flush database', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.getByTitle('Open CLI', { exact: true }).click()
    await cli(page, 'SET ' + key + ' rejected')
    await expect(page.getByRole('log')).toContainText('this connection is read-only')
    await cli(page, 'GET ' + key)
    await expect(page.getByRole('log').locator('pre').last()).toHaveText('(nil)')
  } finally {
    await cleanup(addr, password, key)
    await app.release()
  }
})

/** Create an extended Redis value using its connection's normal type selector and key editor. */
async function createExtended(page, definition) {
  const { type, key, value, field, index } = definition
  await page.getByRole('button', { name: 'New key', exact: true }).click()
  await page.getByLabel('Key name', { exact: true }).fill(key)
  await page.getByRole('combobox', { name: 'Data type', exact: true }).selectOption(type)
  if (field != null) await page.getByLabel('Field / element name').fill(field)
  if (index != null) await page.getByLabel('Index / timestamp').fill(index)
  await page.getByRole('textbox', { name: 'Value', exact: true }).fill(value)
  await page.getByRole('button', { name: 'Create key' }).click()
  await expect(page.getByRole('heading', { name: key, exact: true })).toBeVisible()
}

test('desktop edits RedisJSON, TimeSeries, Vector Sets and Arrays', async ({}) => {
  const stack = process.env.REDIS_TEST_MODULES
  const latest = process.env.REDIS_TEST_NATIVE
  test.skip(!stack || !latest || process.platform !== 'win32', 'set module and modern Redis endpoints on Windows')
  const prefix = 'ardm-wails-types:' + Date.now()
  const app = await launch()
  const { page } = app
  const json = prefix + ':json'
  const series = prefix + ':series'
  const vector = prefix + ':vector'
  const array = prefix + ':array'
  try {
    await english(page)
    await connect(page, 'Redis Stack', false, stack, '')
    await createExtended(page, { type: 'ReJSON-RL', key: json, value: '{"count":5}' })
    await expect(page.getByRole('textbox', { name: 'Value', exact: true })).toHaveValue(/"count": 5/)
    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('{"count":6}')
    await page.getByRole('button', { name: 'Save value' }).click()
    await expect(page.getByRole('textbox', { name: 'Value', exact: true })).toHaveValue(/"count": 6/)
    await createExtended(page, { type: 'TSDB-TYPE', key: series, value: '1.25', index: '1700000000000' })
    await expect(page.getByRole('cell', { name: '1.25', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Info', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('totalSamples')
    await page.getByRole('dialog').locator('button').click()

    await connect(page, 'Redis current', false, latest, '')
    await createExtended(page, { type: 'vectorset', key: vector, value: '1 2', field: 'point' })
    await expect(page.getByRole('cell', { name: 'point', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Similarity', exact: true }).click()
    await page.getByRole('dialog').getByRole('textbox').fill('1 2')
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByRole('dialog')).toContainText('point')
    await page.getByRole('dialog').locator('button').click()

    await createExtended(page, { type: 'array', key: array, value: 'example', index: '2' })
    await expect(page.getByRole('cell', { name: 'example', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Edit entry', exact: true }).click()
    await page.getByRole('dialog').getByRole('textbox', { name: 'Value', exact: true }).fill('updated')
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('cell', { name: 'updated', exact: true })).toBeVisible()
  } finally {
    await cleanup(stack, '', json, series)
    await cleanup(latest, '', vector, array)
    await app.release()
  }
})
