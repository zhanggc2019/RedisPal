import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHTTPServer } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium, expect, test } from '@playwright/test'

const addr = process.env.REDIS_TEST_ADDR
const password = process.env.REDIS_TEST_PASSWORD || ''
const runFile = promisify(execFile)

/** Allocate a loopback-only CDP port for the isolated desktop test profile. */
async function port() {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const number = server.address().port
  await new Promise(resolve => server.close(resolve))
  return number
}

/** Attach Playwright to the actual WebView2 instance and its Wails bindings. */
async function launch(updateURL = '', showWindow = false) {
  const profile = await mkdtemp(join(tmpdir(), 'ardm-wails-e2e-'))
  const cdp = await port()
  const exe = process.env.ARDM_TEST_EXE || join(process.cwd(), '..', 'bin', 'RedisPal-test.exe')
  const processHandle = spawn(exe, [], {
    windowsHide: !showWindow,
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
      process: processHandle,
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
  const dialog = page.getByRole('dialog', { name: 'New connection', exact: true })
  await dialog.getByLabel('Connection name', { exact: true }).fill(name)
  await dialog.getByLabel('Address', { exact: true }).fill(endpoint)
  await dialog.getByLabel('Password', { exact: true }).fill(secret)
  if (readOnly) await dialog.getByLabel('Read-only').check()
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  const result = dialog.getByRole('alert')
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
  const input = page.getByRole('combobox', { name: 'Redis command', exact: true })
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

/** Launch a graphical database tool from the selected connection's actions. */
async function databaseTool(page, name) {
  await page.getByRole('button', { name: 'Database actions', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
}

/** Drive the native window and tray callbacks for this isolated Windows process. */
async function nativeWindow(action, target) {
  const script = fileURLToPath(new URL('./windows-window.ps1', import.meta.url))
  const { stdout } = await runFile('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, action, String(target),
  ], { windowsHide: true, timeout: 8000 })
  return stdout.trim()
}

/** Check that a native close can be cancelled, sent to the tray, or used to quit. */
test('desktop confirms close and can restore the same workspace from the Windows tray', async () => {
  test.skip(process.platform !== 'win32', 'requires the native Windows tray')
  const app = await launch('', true)
  const { page } = app
  try {
    const settings = page.getByRole('button', { name: '设置', exact: true })
    await expect(settings).toBeVisible()
    const pid = app.process.pid
    let window
    await expect.poll(async () => {
      window = await nativeWindow('main', pid)
      return Number(window)
    }).toBeGreaterThan(0)
    const before = (await nativeWindow('message-windows', pid)).split(/\s+/)

    const prompt = page.getByRole('dialog', { name: '关闭 RedisPal', exact: true })
    await nativeWindow('close', window)
    await expect(prompt).toBeVisible()
    await prompt.getByRole('button', { name: '取消', exact: true }).click()
    await expect(prompt).toBeHidden()
    expect(await nativeWindow('visible', window)).toBe('True')

    await nativeWindow('close', window)
    await prompt.getByRole('button', { name: '最小化到托盘', exact: true }).click()
    await expect.poll(() => nativeWindow('visible', window)).toBe('False')
    const after = (await nativeWindow('message-windows', pid)).split(/\s+/)
    const tray = after.find(handle => handle && !before.includes(handle))
    expect(tray).toBeTruthy()
    await nativeWindow('tray-click', tray)
    await expect.poll(() => nativeWindow('visible', window)).toBe('True')
    await expect(settings).toBeVisible()
    await expect(prompt).toBeHidden()

    await english(page)
    await nativeWindow('close', window)
    await page.getByRole('dialog', { name: 'Close RedisPal', exact: true })
      .getByRole('button', { name: 'Quit the app', exact: true }).click()
    await expect.poll(() => app.process.exitCode).toBe(0)
  } finally {
    await app.release()
  }
})

/** Drag an active connection into a newly created group and reload the saved workspace. */
test('desktop moves an existing connection into a new group by drag and drop', async ({}, info) => {
  test.skip(!addr || process.platform !== 'win32', 'set REDIS_TEST_ADDR on Windows for the native test')
  const app = await launch()
  const { page } = app
  try {
    await english(page)
    await connect(page, 'Grouped Redis')
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Connection name', { exact: true }).fill('Other Redis')
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click()
    await page.getByRole('button', { name: 'Manage connections', exact: true }).click()
    await page.getByRole('button', { name: 'New group', exact: true }).click()
    await dialog.getByLabel('New group', { exact: true }).fill('My caches')
    await dialog.getByRole('button', { name: 'Confirm' }).click()

    const target = page.getByRole('button', { name: 'My caches', exact: true })
    const groupedConnection = page.locator('.connection-group').filter({ has: target })
      .getByRole('button', { name: 'Grouped Redis', exact: true })
    const ungroupedConnection = page.locator('.connection-group')
      .filter({ has: page.getByRole('heading', { name: 'Ungrouped', exact: true }) })
      .getByRole('button', { name: 'Other Redis', exact: true })
    await target.click()
    await expect(target).toHaveAttribute('aria-expanded', 'false')
    const row = page.locator('.connection-row').filter({ has: page.getByRole('button', { name: 'Grouped Redis', exact: true }) })
    await row.dragTo(target)
    await expect(target).toHaveAttribute('aria-expanded', 'true')
    await expect(groupedConnection).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Database', exact: true })).toBeVisible()
    await page.reload()
    await expect(groupedConnection).toBeVisible()
    await expect(ungroupedConnection).toBeVisible()
    const [groupedBox, ungroupedBox] = await Promise.all([groupedConnection.boundingBox(), ungroupedConnection.boundingBox()])
    expect(groupedBox.x - ungroupedBox.x).toBeGreaterThanOrEqual(16)
    await page.screenshot({ path: info.outputPath('connection-groups.png') })
  } finally {
    await app.release()
  }
})

/** Check the upgraded default and that subsequent batches preserve every key. */
test('desktop loads 10,000 keys by default and preserves the rest for paging', async () => {
  test.skip(!addr || process.env.REDIS_TEST_ISOLATED !== '1' || process.platform !== 'win32', 'requires an isolated Redis instance')
  const app = await launch()
  const { page } = app
  try {
    await english(page)
    await page.evaluate(() => {
      const workspace = JSON.parse(localStorage.getItem('ardm-workspace-v1'))
      delete workspace.settings.keyPageSize
      workspace.settings.scanCount = 400
      localStorage.setItem('ardm-workspace-v1', JSON.stringify(workspace))
    })
    await page.reload()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const batchSize = page.getByRole('combobox', { name: 'Keys per batch', exact: true })
    await expect(batchSize).toHaveValue('10000')
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()

    await connect(page, 'Key paging fixture')
    await page.getByTitle('Open CLI').click()
    await cli(page, 'SELECT 15')
    await cli(page, `EVAL "for i=1,10037 do redis.call('SET', ARGV[1] .. i, '1') end return 10037" 0 redispal-page:`)
    await expect(page.getByRole('log').getByText('10037', { exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: 'Database', exact: true }).selectOption('15')
    const keyCount = page.locator('.keys-toolbar')
    await expect(keyCount).toContainText('10,000 keys')
    await page.getByRole('button', { name: 'Load more', exact: true }).click()
    await expect(keyCount).toContainText('10,037 keys')
    await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await batchSize.selectOption('400')
    await page.reload()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(batchSize).toHaveValue('400')
  } finally {
    await app.release()
  }
})

/** Exercise the two live debugging panels against a real Redis connection. */
test('desktop publishes and receives messages and captures commands graphically', async ({}, info) => {
  test.skip(!addr || process.platform !== 'win32', 'set REDIS_TEST_ADDR on Windows for the native test')
  const app = await launch()
  const { page } = app
  const marker = 'redispal-live-' + Date.now()
  try {
    await english(page)
    await connect(page, 'Live debugger')
    await databaseTool(page, 'Pub/Sub')
    await page.getByLabel('Subscription channel', { exact: true }).fill(marker)
    await page.getByRole('button', { name: 'Start subscription' }).click()
    await expect(page.getByRole('button', { name: 'Stop subscription' })).toBeVisible()
    await page.getByLabel('Publish channel', { exact: true }).fill(marker)
    await page.getByLabel('Message', { exact: true }).fill('hello from RedisPal')
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Published' })).toContainText(/1 receiving client/)
    await expect(page.getByRole('cell', { name: 'hello from RedisPal', exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('pubsub.png') })
    await page.getByRole('button', { name: 'Stop subscription' }).click()

    await databaseTool(page, 'Profiler')
    await page.getByRole('button', { name: 'Start profiler' }).click()
    await expect(page.getByRole('button', { name: 'Stop profiler' })).toBeVisible()
    await page.getByTitle('Open CLI', { exact: true }).click()
    await cli(page, 'ECHO ' + marker)
    await page.getByRole('tab', { name: 'Profiler', exact: true }).click()
    await page.getByLabel('Filter capture').fill(marker)
    await expect(page.getByRole('cell', { name: new RegExp('"ECHO" "' + marker + '"', 'i') })).toBeVisible()
    await page.getByRole('button', { name: 'Stop profiler' }).click()
    await expect(page.getByRole('button', { name: 'Start profiler' })).toBeEnabled()
    await page.screenshot({ path: info.outputPath('profiler.png') })

    await databaseTool(page, 'Slow log')
    await expect(page.getByRole('heading', { name: 'Slow log', exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: 'Auto-refresh' }).selectOption('1')
    await page.getByRole('button', { name: 'Slow log settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Slow log settings' })
    const threshold = dialog.getByRole('spinbutton', { name: 'Slow command threshold (µs)' })
    const length = dialog.getByRole('spinbutton', { name: 'Maximum log length' })
    await expect(threshold).toHaveValue(/^-?\d+$/)
    await expect(length).toHaveValue(/^\d+$/)
    const nextLength = await length.inputValue() === '256' ? '257' : '256'
    if (process.env.REDIS_TEST_ISOLATED === '1') {
      await length.fill(nextLength)
      await dialog.getByRole('button', { name: 'Apply log length' }).click()
      await expect(dialog.getByRole('status')).toContainText('Setting applied')
      if (await threshold.inputValue() !== '0') {
        await threshold.fill('0')
        await dialog.getByRole('button', { name: 'Apply threshold' }).click()
        await expect(dialog.getByRole('status')).toContainText('Setting applied')
      }
    }
    await page.screenshot({ path: info.outputPath('slow-log-settings.png') })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('1')
    if (process.env.REDIS_TEST_ISOLATED === '1') {
      await page.getByTitle('Open CLI', { exact: true }).click()
      await cli(page, 'ECHO ' + marker + '-slow')
      await page.getByRole('tab', { name: 'Slow log', exact: true }).click()
      await expect(page.getByRole('row').filter({ hasText: marker + '-slow' })).toBeVisible()
      await page.getByRole('button', { name: 'Slow log settings' }).click()
      await expect(threshold).toHaveValue('0')
      await expect(length).toHaveValue(nextLength)
    }
  } finally {
    await app.release()
  }
})

/** Exercise Stream refresh and consumer-group actions against Redis's pending-entry list. */
test('desktop refreshes stream entries and manages consumer groups', async ({}, info) => {
  test.skip(!addr || process.platform !== 'win32', 'set REDIS_TEST_ADDR on Windows for the native test')
  const app = await launch()
  const { page } = app
  const key = 'redispal-stream-' + Date.now()
  try {
    await english(page)
    await connect(page, 'Stream debugger')
    await page.getByTitle('Open CLI', { exact: true }).click()
    await cli(page, 'XADD ' + key + ' * task first-message')
    await page.getByLabel('Search keys', { exact: true }).fill(key)
    await page.getByLabel('Search keys', { exact: true }).press('Enter')
    await page.locator('.key-scroll').getByRole('button', { name: key, exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: 'first-message' })).toBeVisible()
    const live = page.getByRole('switch', { name: 'Live refresh' })
    await live.click()
    await expect(live).toBeChecked()
    await page.getByTitle('Open CLI', { exact: true }).click()
    await cli(page, 'XADD ' + key + ' * task second-message')
    const streamTab = page.getByRole('tab', { name: key, exact: true })
    await streamTab.click()
    await expect(page.getByRole('row').filter({ hasText: 'second-message' })).toBeVisible()

    await page.getByRole('button', { name: 'Consumer groups', exact: true }).click()
    await page.getByRole('button', { name: 'Create group', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Group name').fill('workers')
    await dialog.getByLabel('Start ID').fill('0')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByRole('button', { name: 'workers', exact: true })).toBeVisible()
    await page.getByTitle('Open CLI', { exact: true }).click()
    await cli(page, 'XREADGROUP GROUP workers worker-a COUNT 1 STREAMS ' + key + ' >')
    await expect(page.getByRole('log')).toContainText('first-message')
    await streamTab.click()
    await page.getByRole('button', { name: 'Refresh consumer groups' }).click()
    const pending = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Acknowledge', exact: true }) })
    await expect(pending).toContainText('worker-a')
    await pending.getByRole('button', { name: 'Claim…' }).click()
    await dialog.getByRole('textbox', { name: 'New consumer name', exact: true }).fill('worker-b')
    await dialog.getByRole('button', { name: 'Claim', exact: true }).click()
    await expect(pending).toContainText('worker-b')
    await page.screenshot({ path: info.outputPath('stream-consumer-groups.png') })
    await pending.getByRole('button', { name: 'Acknowledge' }).click()
    await expect(page.getByText('No pending entries', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Delete group', exact: true }).click()
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(page.getByRole('button', { name: 'workers', exact: true })).toHaveCount(0)
  } finally {
    await app.release()
    await cleanup(addr, password, key)
  }
})

/** Verify Search index creation, diagnostics, and the local query library. */
test('desktop creates and queries a Redis Search index', async ({}, info) => {
  test.skip(!addr || process.env.REDIS_TEST_ISOLATED !== '1' || process.platform !== 'win32', 'requires an isolated Redis with Search and JSON')
  const app = await launch()
  const { page } = app
  const prefix = 'redispal-search-' + Date.now() + ':'
  const key = prefix + '1'
  const index = 'idx:' + prefix + 'products'
  try {
    await english(page)
    await connect(page, 'Search debugger')
    await page.getByTitle('Open CLI', { exact: true }).click()
    await cli(page, 'HSET ' + key + ' name "Blue bicycle" price 300')
    await expect(page.getByRole('log').getByText('2', { exact: true })).toBeVisible()
    await databaseTool(page, 'Redis Search')
    await page.getByRole('button', { name: 'Create index', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create search index' })
    await dialog.getByLabel('Example key').fill(key)
    await dialog.getByRole('button', { name: 'Infer fields' }).click()
    await expect(dialog.getByLabel('Field type 1')).toBeVisible()
    await dialog.getByLabel('Index name').fill(index)
    await dialog.getByLabel('Key prefix').fill(prefix)
    await dialog.getByRole('button', { name: 'Create index', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Select index' })).toHaveValue(index)
    const expression = page.getByLabel('Query expression', { exact: true })
    await expression.fill('@na')
    await page.getByRole('button', { name: /^@name/ }).click()
    await expect(expression).toHaveValue('@name:')
    await expression.fill('@name:bicycle')
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.getByRole('table').getByText('Blue bicycle', { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('redis-search.png') })
    await page.getByRole('button', { name: 'Explain', exact: true }).click()
    await expect(page.locator('pre.search-raw').filter({ visible: true })).toContainText(/bicycle/i)
    await page.getByRole('button', { name: 'Profile', exact: true }).click()
    await expect(page.locator('pre.search-raw').filter({ visible: true })).toContainText('Blue bicycle')
    await page.getByRole('button', { name: 'Save query', exact: true }).click()
    const save = page.getByRole('dialog')
    await save.getByLabel('Save query', { exact: true }).fill('Bicycle lookup')
    await save.getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByRole('button', { name: 'Bicycle lookup', exact: true })).toBeVisible()

    await page.getByRole('combobox', { name: 'Query command' }).selectOption('AGGREGATE')
    await page.getByLabel('Command options', { exact: true }).fill('LOAD 1 @name')
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.getByRole('table').getByText('Blue bicycle', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Bicycle lookup', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Query command' })).toHaveValue('SEARCH')

    await page.getByRole('button', { name: 'Load sample data' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByRole('combobox', { name: 'Select index' })).toHaveValue(/^idx:redispal-sample:/)
    await expression.fill('*')
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.getByRole('table').getByRole('row').filter({ hasText: 'City bike' })).toBeVisible()
  } finally {
    await app.release()
    await cleanup(addr, password, key)
  }
})

/** Exercise startup polling and the manual update action against a local GitHub response fixture. */
test('desktop finds a new release automatically and offers its download page', async () => {
  test.skip(process.platform !== 'win32', 'requires the native Windows build')
  const version = process.env.ARDM_TEST_APP_VERSION || '0.0.1'
  const latest = 'v' + version.replace(/\d+$/, patch => String(Number(patch) + 1))
  let checks = 0
  const server = createHTTPServer((_request, response) => {
    checks++
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ tag_name: latest }))
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  let app
  try {
    app = await launch('http://127.0.0.1:' + server.address().port)
    const { page } = app
    const status = page.getByRole('status')
    await expect(status).toContainText('发现新版本')
    await expect(status).toContainText('v' + version + ' → ' + latest)
    await expect(page.getByRole('button', { name: '查看并下载' })).toBeVisible()
    await page.getByRole('button', { name: '关闭更新提示' }).click()
    await expect(status).toHaveCount(0)
    await page.reload()
    await expect.poll(() => checks).toBe(2)
    await expect(status).toHaveCount(0)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('当前版本 v' + version)
    await page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(status).toContainText(latest)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    if (app) await app.release()
    await new Promise(resolve => server.close(resolve))
  }
})

/** Check the Naive UI defaults, the eight custom combinations and saved selections. */
test('desktop applies and saves its built-in themes with readable primary actions', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'requires the native Windows build')
  const app = await launch()
  const { page } = app
  try {
    const root = page.locator('.app')
    const primary = page.getByRole('button', { name: '新建连接', exact: true }).first()
    const settings = page.getByRole('button', { name: '设置', exact: true })
    const dialog = page.getByRole('dialog')
    const mode = dialog.getByRole('combobox', { name: '主题', exact: true })
    const close = dialog.getByRole('button', { name: '关闭设置', exact: true })
    const presets = [['松绿', 'pine'], ['湖蓝', 'lake'], ['暮紫', 'dusk'], ['石墨', 'graphite']]
    await expect(root).toHaveAttribute('data-scheme', 'default')
    await expect(root).toHaveAttribute('data-theme', 'light')
    await expect(primary).toHaveCSS('background-color', 'rgb(24, 160, 88)')
    await page.screenshot({ path: info.outputPath('default-theme.png') })
    for (const theme of ['light', 'dark']) {
      await settings.click()
      await mode.selectOption(theme)
      await close.click()
      await expect(root).toHaveAttribute('data-theme', theme)
      const backgrounds = new Set()
      for (const [name, preset] of presets) {
        await settings.click()
        await dialog.getByText(name, { exact: true }).click()
        await expect(root).toHaveAttribute('data-scheme', preset)
        await close.click()
        const accent = await root.evaluate(element => getComputedStyle(element).getPropertyValue('--accent').trim())
        const expectedRgb = [1, 3, 5].map(index => Number.parseInt(accent.slice(index, index + 2), 16))
        await expect(primary).toHaveCSS('background-color', 'rgb(' + expectedRgb.join(', ') + ')')
        const [background, foreground] = await primary.evaluate(button => {
          const style = getComputedStyle(button)
          return [style.backgroundColor, style.color].map(color => color.match(/\d+/g).slice(0, 3).map(Number))
        })
        backgrounds.add(background.join(','))
        if (preset === 'pine') expect(background[1]).toBeGreaterThan(Math.max(background[0], background[2]))
        const colors = [background, foreground].map(rgb => rgb.map(channel => {
          const value = channel / 255
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0))
        expect((Math.max(...colors) + 0.05) / (Math.min(...colors) + 0.05)).toBeGreaterThanOrEqual(4.5)
        await page.screenshot({ path: info.outputPath(theme + '-' + preset + '.png') })
      }
      expect(backgrounds.size).toBe(presets.length)
    }
    await page.reload()
    await expect(root).toHaveAttribute('data-scheme', 'graphite')
    await expect(root).toHaveAttribute('data-theme', 'dark')
    await settings.click()
    await expect(mode).toHaveValue('dark')
    await expect(dialog.getByRole('radio', { name: '石墨' })).toBeChecked()
    await page.screenshot({ path: info.outputPath('theme-settings.png') })
    await mode.selectOption('system')
    await close.click()
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme })
      await expect(root).toHaveAttribute('data-theme', colorScheme)
    }
    await settings.click()
    await dialog.getByText('Naive UI', { exact: true }).click()
    await mode.selectOption('dark')
    await close.click()
    await expect(primary).toHaveCSS('background-color', 'rgb(99, 226, 183)')
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
    await expect.poll(() => page.locator('.home-logo').evaluate(img => img.naturalWidth)).toBeGreaterThan(0)
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
