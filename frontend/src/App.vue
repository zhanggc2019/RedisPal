<script setup>
import { computed, onMounted, onUnmounted, provide, reactive, ref, watch } from 'vue'
import { darkTheme, enUS, NConfigProvider, zhCN } from 'naive-ui'
import {
  Activity, ChevronDown, ChevronRight, CircleCheck, CircleHelp, Database, Download, Ellipsis, Folder, FolderPlus,
  KeyRound, List, ListChecks, Network, Plus, Radio, RefreshCw, Search, Server, Settings, Terminal, Trash2, Upload, X,
} from '@lucide/vue'
import { Browser, call, updateCall, Window } from './api.js'
import { asArg, decodeBackup, display, download, identity, keyTree, normalizeConnections } from './model.js'
import { normalizeLanguage } from './locale.js'
import { appearance, normalizePreset, themePresets } from './theme.js'
import ConnectionDialog from './ConnectionDialog.vue'
import KeyTree from './KeyTree.vue'
import KeyPanel from './KeyPanel.vue'
import ServerPanel from './ServerPanel.vue'
import CliPanel from './CliPanel.vue'
import ToolsPanel from './ToolsPanel.vue'
import ProfilerPanel from './ProfilerPanel.vue'
import PubSubPanel from './PubSubPanel.vue'
import SearchPanel from './SearchPanel.vue'

/** Read the saved workspace and recover cleanly from invalid browser storage. */
function saved() {
  try {
    return JSON.parse(localStorage.getItem('ardm-workspace-v1')) || {}
  } catch {
    return {}
  }
}

const restored = saved()
const connections = ref(restored.connections || [])
const groups = ref(restored.groups || [])
const keyPageSizes = [100, 400, 1000, 5000, 10000]
const defaultKeyPageSize = 10000
const { scanCount: legacyScanCount, ...savedSettings } = restored.settings || {}
// Older workspaces saved 400 even when the user had never selected a batch size.
const savedKeyPageSize = savedSettings.keyPageSize ?? (legacyScanCount === 400 ? undefined : legacyScanCount)
const settings = reactive({
  theme: 'light', sidebar: 305, zoom: 100, font: '',
  ...savedSettings, language: normalizeLanguage(restored.settings?.language),
  keyPageSize: keyPageSizes.includes(savedKeyPageSize) ? savedKeyPageSize : defaultKeyPageSize,
  scheme: normalizePreset(restored.settings?.scheme),
})
const sessions = reactive({})
const tabs = ref([{ id: 'home', kind: 'home' }])
const activeId = ref('home')
const active = computed(() => tabs.value.find(tab => tab.id === activeId.value) ?? tabs.value[0])
const selectedId = ref('')
const connection = computed(() => connections.value.find(item => item.id === selectedId.value))
const session = computed(() => sessions[selectedId.value])
const hasMoreKeys = computed(() => Boolean(session.value?.cursor || session.value?.pendingKeys?.length))
const connectionFilter = ref('')
const searchingConnections = ref(false)
const collapsedGroups = reactive(new Set())
const draggedConnection = ref(null)
const dropGroup = ref(null)
const connectionDialog = ref(null)
const settingsOpen = ref(false)
const releaseConfig = ref({ version: '', github: false })
const availableUpdate = ref(null)
const checkingUpdates = ref(false)
const shortcutsOpen = ref(false)
const context = ref(null)
const question = ref(null)
const message = ref(null)
const fileInput = ref(null)
const backupInput = ref(null)
const searchInput = ref(null)
const themeQuery = matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(themeQuery.matches)
let messageTimer
let updateTimer

/** Select the current interface language for a label. */
function tr(zh, en) {
  return settings.language === 'en' ? en : zh
}

/** Show the result of a server or workspace operation. */
function notify(text, status = false) {
  clearTimeout(messageTimer)
  const error = status === true
  const success = status === 'success'
  message.value = { text: text?.message || String(text), error, success }
  messageTimer = setTimeout(() => { message.value = null }, error ? 8000 : success ? 5200 : 4200)
}

/** Read the build version and check the GitHub feed in the background. */
async function startUpdateChecks() {
  releaseConfig.value = await updateCall('Configuration')
  if (!releaseConfig.value.github) return
  void checkForUpdate()
  updateTimer = setInterval(checkForUpdate, 6 * 60 * 60 * 1000)
}

/** Check for a newer stable release, surfacing errors only for manual checks. */
async function checkForUpdate(manual = false) {
  if (checkingUpdates.value) return
  checkingUpdates.value = true
  try {
    const release = await updateCall('Check')
    if (!release.version) {
      availableUpdate.value = null
      if (manual) notify(tr('当前已是最新版本', 'You are up to date'))
    } else if (manual || release.version !== localStorage.getItem('ardm-dismissed-update')) {
      availableUpdate.value = release
      if (manual) settingsOpen.value = false
    }
  } catch (error) {
    if (manual) notify(tr('检查更新失败', 'Could not check for updates') + ' · ' + (error.message || String(error)), true)
  } finally {
    checkingUpdates.value = false
  }
}

/** Hide the automatic prompt for this release until a newer version is published. */
function dismissUpdate() {
  localStorage.setItem('ardm-dismissed-update', availableUpdate.value.version)
  availableUpdate.value = null
}

/** Open the official release page in the system browser. */
async function openUpdate() {
  try {
    await Browser.OpenURL(availableUpdate.value.url)
  } catch (error) {
    notify(error, true)
  }
}

/** Ask for a value or explicit destructive-action confirmation inside the desktop window. */
function ask(options) {
  return new Promise(resolve => {
    question.value = { input: false, value: '', ...options, resolve }
  })
}

/** Dismiss an app dialog and resolve its pending action. */
function answer(ok) {
  const dialog = question.value
  if (!dialog) return
  question.value = null
  dialog.resolve(ok ? (dialog.input ? dialog.value : true) : null)
}

provide('tr', tr)
provide('notify', notify)
provide('ask', ask)
watch([connections, groups, settings], () => {
  localStorage.setItem('ardm-workspace-v1', JSON.stringify({ connections: connections.value.filter(item => !item.temporary), groups: groups.value, settings }))
}, { deep: true })
watch(() => settings.language, lang => {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang
}, { immediate: true })
const palette = computed(() => settings.theme === 'dark' || (settings.theme === 'system' && systemDark.value) ? 'dark' : 'light')
const activeTheme = computed(() => appearance(settings.scheme, palette.value, settings.font))
const visibleGroups = computed(() => [...groups.value, { id: '', name: tr('未分组', 'Ungrouped') }].map(group => ({
  ...group,
  connections: connections.value.filter(item => (item.groupId || '') === group.id &&
    (item.name + ' ' + item.addr).toLowerCase().includes(connectionFilter.value.trim().toLowerCase())),
})).filter(group => group.id ? !connectionFilter.value || group.connections.length : group.connections.length))
const tree = computed(() => session.value ? keyTree(
  session.value.keys, session.value.tree ? connection.value?.separator : '',
) : [])
const selectedKeys = computed(() => session.value?.keys.filter(key => session.value.selected.has(identity(key))) || [])

/** Open an empty editor or a copy of the selected connection. */
function editConnection(item = null, clone = false) {
  context.value = null
  const defaults = normalizeConnections([{ addr: '127.0.0.1:6379', name: ' ', separator: ':' }]).connections[0]
  const initial = { ...defaults, name: '', ...item }
  delete initial.temporary
  if (clone) {
    initial.id = crypto.randomUUID()
    initial.name += tr(' 副本', ' copy')
    initial.dbNames = { ...initial.dbNames }
  }
  connectionDialog.value = { initial, editing: Boolean(item && !clone) }
}

/** Save connection changes and release live clients when their settings change. */
async function saveConnection(item) {
  const index = connections.value.findIndex(connection => connection.id === item.id)
  if (index === -1) connections.value.push(item)
  else {
    if (sessions[item.id]) await disconnect(item.id)
    connections.value[index] = item
  }
  connectionDialog.value = null
}

/** Open a saved server and populate its database selector and first key page. */
async function connect(item) {
  selectedId.value = item.id
  if (sessions[item.id]) {
    if (!sessions[item.id].connecting) openTab({ kind: 'server', connection: item.id })
    return
  }
  sessions[item.id] = { connecting: true }
  try {
    await call('Connect', item.id, item)
    const info = await call('Info', item.id, 0)
    const db = info.databases.includes(item.lastDb) ? item.lastDb : 0
    sessions[item.id] = {
      connecting: false, db, info, keys: [], pendingKeys: [], cursor: '', query: '', exact: false, tree: Boolean(item.separator),
      expanded: new Set(), selected: new Set(), seen: new Set(), multi: false, loading: false, revision: 0, sorting: false,
      history: item.searchHistory || [],
    }
    if (selectedId.value === item.id) openTab({ kind: 'server', connection: item.id })
    notify(tr('连接成功', 'Connection successful') + ' · ' + item.name, 'success')
    await scan(item.id, true)
  } catch (error) {
    delete sessions[item.id]
    await call('Disconnect', item.id).catch(() => {})
    notify(error, true)
  }
}

/** Close the server's tabs before dropping its backend session. */
async function disconnect(id) {
  context.value = null
  tabs.value = tabs.value.filter(tab => tab.connection !== id)
  if (!tabs.value.some(tab => tab.id === activeId.value)) activeId.value = 'home'
  delete sessions[id]
  await call('Disconnect', id).catch(error => notify(error, true))
}

/** Remove only the saved profile after explicit confirmation. */
async function removeConnection(item) {
  context.value = null
  if (!await ask({ title: tr('删除连接', 'Delete connection'), text: item.name, danger: true })) return
  await disconnect(item.id)
  connections.value = connections.value.filter(connection => connection.id !== item.id)
}

/** Add or rename a locally stored connection group. */
async function editGroup(group) {
  context.value = null
  const value = await ask({ title: group ? tr('重命名分组', 'Rename group') : tr('新建分组', 'New group'), input: true, value: group?.name || '' })
  const name = value?.trim()
  if (!name) return
  if (groups.value.some(item => item.name === name && item.id !== group?.id)) return notify(tr('分组名称已存在', 'Group name is already used'), true)
  if (group) groups.value.find(item => item.id === group.id).name = name
  else groups.value.push({ id: crypto.randomUUID(), name })
}

/** Drop a group and keep its connections available in the ungrouped list. */
async function removeGroup(group) {
  context.value = null
  if (!await ask({ title: tr('删除分组', 'Delete group'), text: group.name, danger: true })) return
  for (const item of connections.value) if (item.groupId === group.id) item.groupId = ''
  groups.value = groups.value.filter(item => item.id !== group.id)
}

/** Move a saved connection one row in its own group. */
function moveConnection(item, delta) {
  const index = connections.value.indexOf(item)
  const neighbours = connections.value.map((c, i) => ({ c, i })).filter(({ c }) => c.groupId === item.groupId)
  const target = neighbours[neighbours.findIndex(({ i }) => i === index) + delta]
  if (target) [connections.value[index], connections.value[target.i]] = [connections.value[target.i], connections.value[index]]
  context.value = null
}

/** Track a connection dragged from the sidebar without exposing its configuration. */
function startConnectionDrag(event, item) {
  if (!event.dataTransfer) return
  draggedConnection.value = item
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-redispal-connection', item.id)
}

/** Accept an in-app drag only over a different named group. */
function overConnectionGroup(event, groupId) {
  if (!groupId || !draggedConnection.value || draggedConnection.value.groupId === groupId) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dropGroup.value = groupId
}

/** Retain the highlight when the pointer moves between children of a group. */
function leaveConnectionGroup(event, groupId) {
  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
  if (dropGroup.value === groupId) dropGroup.value = null
}

/** Move the saved profile without changing its ID or its active Redis session. */
function dropConnection(event, groupId) {
  const item = draggedConnection.value
  if (!item) return
  event.preventDefault()
  if (groupId && groupId !== item.groupId && groups.value.some(group => group.id === groupId)) {
    item.groupId = groupId
    collapsedGroups.delete(groupId)
  }
  endConnectionDrag()
}

/** Clear transient drag state after a drop or cancellation. */
function endConnectionDrag() {
  draggedConnection.value = null
  dropGroup.value = null
}

/** Import legacy or current connection bundles and leave existing profiles intact. */
async function importConnections(event) {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  try {
    const parsed = normalizeConnections(JSON.parse(await file.text()))
    for (const group of parsed.groups) {
      const present = groups.value.find(item => item.id === group.id || item.name === group.name)
      if (present) {
        for (const item of parsed.connections) if (item.groupId === group.id) item.groupId = present.id
      } else groups.value.push(group)
    }
    for (const item of parsed.connections) {
      if (connections.value.some(connection => connection.id === item.id)) item.id = crypto.randomUUID()
      connections.value.push(item)
    }
    notify(tr('已导入连接', 'Connections imported') + ' · ' + parsed.connections.length)
  } catch (error) {
    notify(error, true)
  }
}

/** Export saved profiles and groups in a single configuration bundle. */
async function exportConnections() {
  if (!await ask({ title: tr('导出连接', 'Export connections'), text: tr('连接文件包含已保存的密码。', 'This file includes saved passwords.') })) return
  download('redis-connections.json', JSON.stringify({ connections: connections.value.filter(item => !item.temporary), groups: groups.value }, null, 2))
}

/** Fill one key-list batch and carry overflow from Redis SCAN into subsequent batches. */
async function scan(id, reset = false, all = false) {
  const state = sessions[id]
  if (!state || state.connecting || (state.loading && !reset) || (!reset && !state.cursor && !state.pendingKeys.length)) return
  if (reset) {
    state.keys = []
    state.pendingKeys = []
    state.cursor = ''
    state.seen.clear()
    state.selected.clear()
  }
  const revision = ++state.revision
  const { db, query, exact } = state
  const pageSize = settings.keyPageSize
  const limit = all ? Infinity : state.keys.length + pageSize
  state.loading = true
  const pattern = exact ? query : (!query ? '*' : /[*?\[\\]/.test(query) ? query : '*' + query + '*')
  try {
    for (const value of state.pendingKeys.splice(0, limit - state.keys.length)) state.keys.push(value)
    let first = reset
    while ((first || state.cursor) && state.keys.length < limit) {
      first = false
      const page = await call('Scan', id, db, pattern, state.cursor, exact, pageSize)
      if (revision !== state.revision || sessions[id] !== state) return
      state.cursor = page.cursor
      for (const value of page.keys) {
        const key = identity(value)
        if (state.seen.has(key)) continue
        state.seen.add(key)
        if (state.keys.length < limit) state.keys.push(value)
        else state.pendingKeys.push(value)
      }
    }
  } catch (error) {
    if (revision === state.revision) notify(error, true)
  } finally {
    if (revision === state.revision) {
      if (state.sorting) state.keys.sort((a, b) => display(a).localeCompare(display(b)))
      state.loading = false
    }
  }
}

/** Save a search suggestion and restart from the beginning of the selected database. */
function search() {
  if (session.value.query) {
    session.value.history = [...new Set([session.value.query, ...session.value.history])].slice(0, 30)
    connection.value.searchHistory = session.value.history
  }
  return scan(selectedId.value, true)
}

/** Select a new logical database without changing already opened tabs. */
async function selectDatabase(db) {
  const state = session.value
  const item = connection.value
  const id = item.id
  state.db = db
  item.lastDb = db
  state.expanded.clear()
  openTab({ kind: 'server', connection: id })
  await scan(id, true)
}

/** Label the current database with an optional user-provided name. */
async function nameDatabase() {
  const item = connection.value
  const db = session.value.db
  const name = await ask({ title: tr('数据库名称', 'Database name'), input: true, value: item.dbNames?.[db] ?? '' })
  if (name !== null) item.dbNames = { ...item.dbNames, [db]: name.trim() }
}

/** Switch between the key tree and the flat list. */
function toggleTree() {
  session.value.tree = !session.value.tree
}

/** Expand or collapse one folder while preserving its exact key identity. */
function toggleFolder(id) {
  const expanded = session.value.expanded
  if (expanded.has(id)) expanded.delete(id)
  else expanded.add(id)
}

/** Toggle membership in the explicit batch selection. */
function checkKey(key) {
  const selected = session.value.selected
  const id = identity(key)
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
}

/** Reuse a key/status tab, or create a fresh CLI tab with its own session history. */
function openTab(data, fresh = false) {
  const id = fresh ? crypto.randomUUID() : JSON.stringify([data.kind, data.connection, data.db, data.key === undefined ? null : identity(data.key)])
  if (!tabs.value.some(tab => tab.id === id)) tabs.value.push({ id, ...data })
  activateTab(id)
}

/** Activate a workspace tab and restore the corresponding sidebar connection. */
function activateTab(id) {
  activeId.value = id
  const tab = tabs.value.find(item => item.id === id)
  if (tab?.connection) selectedId.value = tab.connection
}

/** Close one tab and return focus to its nearest surviving neighbour. */
function closeTab(id) {
  const index = tabs.value.findIndex(tab => tab.id === id)
  if (index <= 0) return
  tabs.value.splice(index, 1)
  if (activeId.value === id) activateTab(tabs.value[index - 1].id)
}

/** Open a key tab scoped to the exact database and raw bytes selected in the sidebar. */
function openKey(key) {
  openTab({ kind: 'key', connection: selectedId.value, db: session.value.db, key })
}

/** Refresh names and update open tabs after creating, renaming or deleting a key. */
function keyChanged(tab, key) {
  const state = sessions[tab.connection]
  if (key !== undefined) {
    const next = { kind: 'key', connection: tab.connection, db: tab.db, key }
    openTab(next)
    if (key !== tab.key) closeTab(tab.id)
  } else closeTab(tab.id)
  if (state && state.db === tab.db) scan(tab.connection, true)
}

/** Open a server-side tools tab on the currently selected database. */
function openTool(kind, fresh = false) {
  context.value = null
  openTab({ kind, connection: selectedId.value, db: session.value.db }, fresh)
}

/** Format the tab caption from its connection, database or raw key. */
function tabName(tab) {
  const name = connections.value.find(item => item.id === tab.connection)?.name
  switch (tab.kind) {
    case 'home': return tr('工作台', 'Workspace')
    case 'server': return name
    case 'key': return display(tab.key) || '␀'
    case 'new': return tr('新建 Key', 'New key')
    case 'cli': return 'CLI · ' + name
    case 'pubsub': return 'Pub/Sub'
    case 'search': return 'Redis Search'
    case 'profiler': return tr('实时监控', 'Profiler')
    case 'slow': return tr('慢日志', 'Slow log')
    case 'memory': return tr('内存分析', 'Memory analysis')
    case 'logs': return tr('命令日志', 'Command log')
    default: return tab.kind
  }
}

/** Export selected keys using Redis DUMP and an explicit expiration timestamp. */
async function exportKeys() {
  const keys = selectedKeys.value.length ? selectedKeys.value : session.value.keys
  if (!keys.length) return notify(tr('当前没有可导出的键', 'No keys to export'))
  try {
    const rows = await call('Export', selectedId.value, session.value.db, keys.map(asArg))
    download('redis-keys-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ keys: rows }))
    notify(tr('已导出键', 'Keys exported') + ' · ' + rows.length)
  } catch (error) {
    notify(error, true)
  }
}

/** Restore JSON/legacy CSV backups, reporting per-key failures without hiding successful rows. */
async function importKeys(event) {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file || !session.value) return
  const id = selectedId.value
  const db = session.value.db
  try {
    const entries = decodeBackup(await file.text())
    if (!await ask({ title: tr('导入键', 'Import keys'), text: 'DB ' + db + ' · ' + entries.length + tr(' 个键', ' keys') })) return
    const replace = await ask({ title: tr('覆盖已存在的键', 'Replace existing keys'), text: tr('取消将保留现有键，继续导入其他键。', 'Cancel keeps existing keys and imports the others.') })
    const result = await call('Import', id, db, entries, Boolean(replace))
    notify(tr('导入', 'Imported') + ' · ' + result.imported + (result.errors.length ? ' / ' + result.errors.slice(0, 3).join('\n') : ''), result.errors.length > 0)
    if (sessions[id]?.db === db) await scan(id, true)
  } catch (error) {
    notify(error, true)
  }
}

/** Delete exactly the selected keys after confirming the database and number of keys. */
async function deleteKeys() {
  const keys = selectedKeys.value
  const id = selectedId.value
  const db = session.value.db
  if (!keys.length || !await ask({ title: tr('批量删除键', 'Delete selected keys'), text: 'DB ' + db + ' · ' + keys.length + tr(' 个键', ' keys'), danger: true })) return
  try {
    const result = await call('Delete', id, db, keys.map(asArg))
    const deleted = new Set(keys.map(identity))
    if (!result.errors.length) {
      for (const tab of [...tabs.value]) if (tab.kind === 'key' && tab.connection === id && tab.db === db && deleted.has(identity(tab.key))) closeTab(tab.id)
    }
    notify(tr('已删除键', 'Keys deleted') + ' · ' + result.imported + (result.errors.length ? '\n' + result.errors[0] : ''), result.errors.length > 0)
    if (sessions[id]?.db === db) await scan(id, true)
  } catch (error) {
    notify(error, true)
  }
}

/** Clear exactly one selected database after requiring its displayed name to be typed. */
async function flushDatabase() {
  context.value = null
  const id = selectedId.value
  const db = session.value.db
  const name = connection.value.name
  const confirmation = 'DB ' + db
  const text = tr('此操作将删除该数据库中的所有键。输入 ', 'This deletes all keys in the selected database. Type ') + confirmation
  const result = await ask({ title: tr('清空数据库', 'Flush database'), text: name + '\n' + text, input: true, danger: true })
  if (result === null) return
  if (result.trim() !== confirmation) return notify(tr('确认文本不匹配', 'Confirmation text did not match'), true)
  try {
    await call('Flush', id, db)
    for (const tab of [...tabs.value]) if (tab.kind === 'key' && tab.connection === id && tab.db === db) closeTab(tab.id)
    if (sessions[id]?.db === db) await scan(id, true)
    notify(tr('数据库已清空', 'Database cleared'))
  } catch (error) {
    notify(error, true)
  }
}

/** Position the connection, group, tab, or key operations menu in the viewport. */
function menu(event, kind, value) {
  context.value = { x: Math.max(4, Math.min(event.clientX, innerWidth - 218)), y: Math.max(4, Math.min(event.clientY, innerHeight - 300)), kind, value }
}

/** Keep the two-panel layout usable while resizing the left pane. */
function resize(event) {
  const grip = event.currentTarget
  grip.setPointerCapture(event.pointerId)
  grip.onpointermove = move => { settings.sidebar = Math.round(Math.min(Math.max(move.clientX, 225), innerWidth * 0.6)) }
  grip.onlostpointercapture = () => { grip.onpointermove = null }
}

/** Update theme when Windows changes color mode. */
function systemTheme(event) {
  systemDark.value = event.matches
}

/** Dispatch the desktop keyboard shortcuts from any active panel. */
function shortcut(event) {
  if (event.key === 'Escape') context.value = null
  if (!event.ctrlKey && !event.metaKey) return
  const key = event.key.toLowerCase()
  const actions = {
    n: () => session.value && !session.value.connecting && !connection.value.readOnly ? openTool('new', true) : editConnection(),
    f: () => searchInput.value?.focus(),
    w: () => closeTab(activeId.value),
    b: () => session.value && !session.value.connecting && openTool('cli', true),
    r: () => session.value && scan(selectedId.value, true),
    m: () => Window.Minimise(),
    enter: () => Window.ToggleMaximise(),
  }
  if (actions[key]) {
    event.preventDefault()
    actions[key]()
  }
}

onMounted(async () => {
  themeQuery.addEventListener('change', systemTheme)
  window.addEventListener('keydown', shortcut)
  startUpdateChecks().catch(() => {})
  try {
    const launch = await call('Startup')
    if (launch?.connection?.addr) {
      const item = normalizeConnections([{ ...launch.connection, name: launch.name, separator: launch.separator }]).connections[0]
      item.temporary = !launch.save
      connections.value.push(item)
      await connect(item)
    }
  } catch (error) {
    notify(error, true)
  }
})
onUnmounted(() => {
  themeQuery.removeEventListener('change', systemTheme)
  window.removeEventListener('keydown', shortcut)
  clearTimeout(messageTimer)
  clearInterval(updateTimer)
})
</script>

<template>
  <NConfigProvider abstract :theme="palette === 'dark' ? darkTheme : null" :theme-overrides="activeTheme.naive" :locale="settings.language === 'zh' ? zhCN : enUS">
  <div class="app" :data-theme="palette" :data-scheme="settings.scheme"
    :style="{ ...activeTheme.css, '--sidebar-width': settings.sidebar + 'px', '--ui-scale': settings.zoom / 100, '--workspace-font': settings.font || undefined }"
    @click="context = null">
    <aside class="sidebar">
      <header class="brand"><img src="/logo.png" alt=""><div><strong>RedisPal</strong></div>
        <NButton size="small" quaternary class="flat icon" :title="tr('设置', 'Settings')" :aria-label="tr('设置', 'Settings')" @click="settingsOpen = true"><Settings :size="17" /></NButton>
      </header>
      <div class="connection-actions">
        <NButton size="medium" type="primary" class="primary add-connection" @click="editConnection()"><Plus :size="17" />{{ tr('新建连接', 'New connection') }}</NButton>
        <NButton size="small" class="icon" :title="tr('连接管理', 'Manage connections')" :aria-label="tr('连接管理', 'Manage connections')" @click.stop="menu($event, 'workspace')"><Ellipsis :size="18" /></NButton>
      </div>
      <section class="connections">
        <div class="section-title"><h2>{{ tr('连接', 'Connections') }}</h2>
          <NButton size="small" quaternary class="flat icon" :title="tr('搜索连接', 'Search connections')" @click="searchingConnections = !searchingConnections; connectionFilter = ''"><Search :size="15" /></NButton>
        </div>
        <NInput v-if="searchingConnections" v-model:value="connectionFilter" size="small" class="connection-filter" :placeholder="tr('搜索连接', 'Search connections')" />
        <div v-if="!connections.length" class="empty-side">{{ tr('暂无连接', 'No saved connections') }}</div>
        <div v-for="group in visibleGroups" :key="group.id || 'root'" class="connection-group"
          :class="{ 'drop-target': dropGroup === group.id }" @dragover="overConnectionGroup($event, group.id)"
          @dragleave="leaveConnectionGroup($event, group.id)" @drop="dropConnection($event, group.id)">
          <div v-if="group.id" class="group-row" @contextmenu.prevent.stop="menu($event, 'group', group)">
            <NButton size="small" quaternary class="flat group-name" :aria-expanded="!collapsedGroups.has(group.id) || Boolean(connectionFilter)"
              @click="collapsedGroups.has(group.id) ? collapsedGroups.delete(group.id) : collapsedGroups.add(group.id)">
              <ChevronRight v-if="collapsedGroups.has(group.id) && !connectionFilter" :size="13" /><ChevronDown v-else :size="13" />
              <Folder :size="15" /><span>{{ group.name }}</span>
            </NButton>
            <NButton size="small" quaternary class="flat icon row-menu" :title="tr('分组操作', 'Group actions')" @click.stop="menu($event, 'group', group)"><Ellipsis :size="15" /></NButton>
          </div>
          <h3 v-else-if="groups.length" class="ungrouped-heading">{{ group.name }}</h3>
          <div v-if="group.connections.length && (!collapsedGroups.has(group.id) || connectionFilter)" :class="{ 'group-children': group.id }">
            <div v-for="item in group.connections" :key="item.id"
              class="connection-row" :class="{ current: item.id === selectedId, dragging: draggedConnection?.id === item.id }"
              draggable="true" @dragstart="startConnectionDrag($event, item)" @dragend="endConnectionDrag" @contextmenu.prevent.stop="menu($event, 'connection', item)">
              <NButton size="small" quaternary class="flat connection-name" :title="item.addr" @click="connect(item)">
                <Server :size="16" :style="{ color: item.color || undefined }" /><span>{{ item.name }}</span>
                <span v-if="sessions[item.id]" class="dot" :class="{ pending: sessions[item.id].connecting }"></span>
              </NButton>
              <NButton size="small" quaternary class="flat icon row-menu" :aria-label="tr('连接操作', 'Connection actions')" @click.stop="menu($event, 'connection', item)"><Ellipsis :size="16" /></NButton>
            </div>
          </div>
        </div>
      </section>
      <section v-if="session && !session.connecting" class="browser">
        <div class="db-bar">
          <div class="db-select"><Database :size="16" /><select :value="session.db" :aria-label="tr('数据库', 'Database')" @change="selectDatabase(Number($event.target.value))">
            <option v-for="db in session.info.databases" :key="db" :value="db">DB {{ db }}{{ connection.dbNames?.[db] ? ' · ' + connection.dbNames[db] : '' }}</option>
          </select></div>
          <NButton size="small" class="icon" :title="tr('服务器状态', 'Server status')" @click="openTab({ kind: 'server', connection: selectedId })"><Activity :size="16" /></NButton>
          <NButton size="small" class="icon" :title="tr('打开命令行', 'Open CLI')" @click="openTool('cli', true)"><Terminal :size="17" /></NButton>
          <NButton size="small" class="icon" :aria-label="tr('数据库操作', 'Database actions')" @click.stop="menu($event, 'database')"><Ellipsis :size="17" /></NButton>
        </div>
        <form class="search-bar" @submit.prevent="search">
          <div class="search-field"><Search :size="15" /><input ref="searchInput" v-model="session.query" list="key-search-history"
            :placeholder="tr('搜索 Key', 'Search keys')" :aria-label="tr('搜索 Key', 'Search keys')" spellcheck="false">
            <datalist id="key-search-history"><option v-for="item in session.history" :key="item" :value="item"></option></datalist>
            <NButton size="small" quaternary class="flat exact" :class="{ toggled: session.exact }" :aria-pressed="session.exact" :title="tr('精确匹配', 'Exact match')"
              @click="session.exact = !session.exact; search()">=</NButton>
          </div>
          <NButton size="small" attr-type="submit" class="icon" :title="tr('搜索', 'Search')"><Search :size="15" /></NButton>
        </form>
        <div class="keys-toolbar">
          <span>{{ session.keys.length.toLocaleString() }} {{ tr('个键', 'keys') }}</span>
          <NButton size="small" quaternary class="flat icon" :title="tr('刷新键列表', 'Refresh keys')" @click="scan(selectedId, true)"><RefreshCw :size="15" :class="{ spin: session.loading }" /></NButton>
          <NButton size="small" quaternary class="flat icon" :title="tr('切换树形 / 列表', 'Toggle tree/list')" :aria-pressed="session.tree" @click="toggleTree"><Network v-if="session.tree" :size="15" /><List v-else :size="16" /></NButton>
          <NButton size="small" quaternary class="flat icon" :title="tr('多选', 'Multi-select')" :aria-pressed="session.multi" @click="session.multi = !session.multi; session.selected.clear()"><ListChecks :size="16" /></NButton>
          <NButton size="small" quaternary class="flat icon" :title="tr('新建 Key', 'New key')" :aria-label="tr('新建 Key', 'New key')" :disabled="connection.readOnly" @click="openTool('new', true)"><Plus :size="17" /></NButton>
        </div>
        <div v-if="session.multi" class="batch-bar">
          <NButton size="small" quaternary class="flat" @click="session.selected.size ? session.selected.clear() : session.keys.forEach(key => session.selected.add(identity(key)))">
            {{ session.selected.size ? tr('取消全选', 'Clear selection') : tr('全选已加载', 'Select loaded keys') }}
          </NButton>
          <span>{{ session.selected.size }}</span>
          <NButton size="small" quaternary class="icon flat" :title="tr('导出键', 'Export keys')" :disabled="!session.selected.size" @click="exportKeys"><Download :size="15" /></NButton>
          <NButton size="small" quaternary type="error" class="icon flat danger" :title="tr('批量删除键', 'Delete selected keys')" :disabled="!session.selected.size || connection.readOnly" @click="deleteKeys"><Trash2 :size="15" /></NButton>
        </div>
        <div class="key-scroll">
          <KeyTree :nodes="tree" :expanded="session.expanded" :selected="session.selected"
            :active="active.kind === 'key' && active.connection === selectedId && active.db === session.db ? identity(active.key) : ''"
            :multi="session.multi" @open="openKey" @toggle="toggleFolder" @check="checkKey" />
          <div v-if="!session.keys.length && !session.loading" class="empty-side">{{ tr('没有匹配的键', 'No matching keys') }}</div>
        </div>
        <div v-if="hasMoreKeys || session.loading" class="paging">
          <NButton size="small" :disabled="session.loading" @click="scan(selectedId)">{{ session.loading ? tr('正在扫描…', 'Scanning…') : tr('加载更多', 'Load more') }}</NButton>
          <NButton size="small" v-if="hasMoreKeys" :disabled="session.loading" @click="scan(selectedId, false, true)">{{ tr('全部加载', 'Load all') }}</NButton>
        </div>
      </section>
      <footer class="sidebar-footer">
        <span v-if="session && !session.connecting"><i class="dot"></i>{{ tr('已连接', 'Connected') }}</span>
        <span v-else>{{ tr('Redis 桌面客户端', 'Redis desktop client') }}</span>
        <NButton size="small" quaternary class="flat icon" :title="tr('快捷键', 'Keyboard shortcuts')" @click="shortcutsOpen = true"><CircleHelp :size="17" /></NButton>
      </footer>
    </aside>
    <div class="resize-grip" role="separator" aria-orientation="vertical" @pointerdown.prevent="resize"></div>
    <main class="workbench">
      <div class="tabs" role="tablist" @wheel.passive="$event.currentTarget.scrollLeft += $event.deltaY">
        <div v-for="tab in tabs" :key="tab.id" class="tab-shell" :class="{ active: tab.id === activeId }" @contextmenu.prevent.stop="menu($event, 'tab', tab)">
          <NButton size="small" quaternary class="tab-button flat" role="tab" :aria-selected="tab.id === activeId" :title="tabName(tab)" @click="activateTab(tab.id)">
            <KeyRound v-if="tab.kind === 'key' || tab.kind === 'new'" :size="14" /><Terminal v-else-if="tab.kind === 'cli'" :size="14" />
            <Radio v-else-if="tab.kind === 'pubsub'" :size="14" /><Search v-else-if="tab.kind === 'search'" :size="14" />
            <Database v-else-if="tab.kind === 'home'" :size="14" /><Activity v-else :size="14" />
            <span>{{ tabName(tab) }}</span>
          </NButton>
          <NButton size="small" quaternary v-if="tab.kind !== 'home'" class="flat icon close-tab" :aria-label="tr('关闭标签', 'Close tab')" @click="closeTab(tab.id)"><X :size="13" /></NButton>
        </div>
      </div>
      <div v-if="availableUpdate" class="update-banner">
        <Download :size="17" aria-hidden="true" />
        <div class="update-message" role="status">
          <strong>{{ tr('发现新版本', 'Update available') }}</strong>
          <span>{{ releaseConfig.version }} → {{ availableUpdate.version }}</span>
        </div>
        <NButton size="small" type="primary" class="primary" @click="openUpdate">{{ tr('查看并下载', 'View and download') }}</NButton>
        <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭更新提示', 'Dismiss update')" @click="dismissUpdate"><X :size="16" /></NButton>
      </div>
      <section v-show="active.kind === 'home'" class="home">
        <NCard class="home-card" content-style="padding: 0">
          <div class="home-intro">
            <img src="/logo.png" alt="" class="home-logo">
            <div>
              <h1>RedisPal</h1>
              <p>{{ tr('打开已有连接，或添加一个 Redis 服务器。', 'Open a saved connection or add a Redis server.') }}</p>
            </div>
          </div>
          <div class="home-actions">
            <NButton type="primary" class="primary" @click="editConnection()"><Plus :size="17" />{{ tr('新建连接', 'New connection') }}</NButton>
            <NButton @click="fileInput.click()"><Upload :size="16" />{{ tr('导入连接', 'Import connections') }}</NButton>
          </div>
        </NCard>
      </section>
      <template v-for="tab in tabs" :key="tab.id">
        <section v-if="tab.connection && sessions[tab.connection] && !sessions[tab.connection].connecting" v-show="activeId === tab.id" class="tab-panel">
          <ServerPanel v-if="tab.kind === 'server'" :visible="activeId === tab.id" :connection="connections.find(item => item.id === tab.connection)" :db="sessions[tab.connection].db" :info="sessions[tab.connection].info"
            @info="info => { if (sessions[tab.connection]) sessions[tab.connection].info = info }" />
          <KeyPanel v-else-if="tab.kind === 'key' || tab.kind === 'new'" :tab="tab" :connection="connections.find(item => item.id === tab.connection)" :visible="activeId === tab.id"
            @change="key => keyChanged(tab, key)" @refresh-list="scan(tab.connection, true)" @open-key="key => openTab({ kind: 'key', connection: tab.connection, db: tab.db, key })" />
          <CliPanel v-else-if="tab.kind === 'cli'" :tab="tab" :visible="activeId === tab.id" :connection="connections.find(item => item.id === tab.connection)" />
          <PubSubPanel v-else-if="tab.kind === 'pubsub'" :tab="tab" :connection="connections.find(item => item.id === tab.connection)" />
          <SearchPanel v-else-if="tab.kind === 'search'" :tab="tab" :connection="connections.find(item => item.id === tab.connection)"
            @open-key="key => openTab({ kind: 'key', connection: tab.connection, db: tab.db, key })" />
          <ProfilerPanel v-else-if="tab.kind === 'profiler'" :tab="tab" :connection="connections.find(item => item.id === tab.connection)" />
          <ToolsPanel v-else :tab="tab" :connection="connections.find(item => item.id === tab.connection)" :visible="activeId === tab.id" />
        </section>
      </template>
    </main>
    <div id="overlay-host"></div>
    <input ref="fileInput" type="file" hidden accept=".json,application/json" @change="importConnections">
    <input ref="backupInput" type="file" hidden accept=".json,.csv" @change="importKeys">

    <div v-if="context" class="context-menu" :style="{ left: context.x + 'px', top: context.y + 'px' }" @click.stop>
      <template v-if="context.kind === 'workspace'">
        <NButton size="small" quaternary class="flat" @click="editGroup()"><FolderPlus :size="16" />{{ tr('新建分组', 'New group') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="context = null; fileInput.click()"><Upload :size="15" />{{ tr('导入连接', 'Import connections') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="context = null; exportConnections()"><Download :size="15" />{{ tr('导出连接', 'Export connections') }}</NButton>
      </template>
      <template v-else-if="context.kind === 'connection'">
        <NButton size="small" quaternary class="flat" @click="editConnection(context.value)">{{ tr('编辑连接', 'Edit connection') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="editConnection(context.value, true)">{{ tr('克隆连接', 'Clone connection') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="moveConnection(context.value, -1)">{{ tr('上移', 'Move up') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="moveConnection(context.value, 1)">{{ tr('下移', 'Move down') }}</NButton>
        <NButton size="small" quaternary v-if="sessions[context.value.id]" class="flat" @click="disconnect(context.value.id)">{{ tr('断开连接', 'Disconnect') }}</NButton>
        <NButton size="small" quaternary type="error" class="flat danger" @click="removeConnection(context.value)">{{ tr('删除连接', 'Delete connection') }}</NButton>
      </template>
      <template v-else-if="context.kind === 'group'">
        <NButton size="small" quaternary class="flat" @click="editGroup(context.value)">{{ tr('重命名分组', 'Rename group') }}</NButton>
        <NButton size="small" quaternary type="error" class="flat danger" @click="removeGroup(context.value)">{{ tr('删除分组', 'Delete group') }}</NButton>
      </template>
      <template v-else-if="context.kind === 'database'">
        <NButton size="small" quaternary class="flat" @click="openTool('pubsub')"><Radio :size="15" />Pub/Sub</NButton>
        <NButton size="small" quaternary class="flat" @click="openTool('search')"><Search :size="15" />Redis Search</NButton>
        <NButton size="small" quaternary class="flat" @click="openTool('profiler')"><Activity :size="15" />{{ tr('实时监控', 'Profiler') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="openTool('slow')">{{ tr('慢日志', 'Slow log') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="context = null; nameDatabase()">{{ tr('命名数据库', 'Name database') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="context = null; session.sorting = !session.sorting; scan(selectedId, true)">{{ session.sorting ? tr('按扫描顺序', 'Order by scan') : tr('按名称排序', 'Sort by name') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="openTool('memory')">{{ tr('内存分析', 'Memory analysis') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="openTool('logs')">{{ tr('命令日志', 'Command log') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="context = null; exportKeys()">{{ tr('导出键', 'Export keys') }}</NButton>
        <NButton size="small" quaternary class="flat" :disabled="connection.readOnly" @click="context = null; backupInput.click()">{{ tr('导入键', 'Import keys') }}</NButton>
        <NButton size="small" quaternary type="error" class="flat danger" :disabled="connection.readOnly" @click="flushDatabase">{{ tr('清空数据库', 'Flush database') }}</NButton>
      </template>
      <template v-else-if="context.kind === 'tab'">
        <NButton size="small" quaternary class="flat" :disabled="context.value.kind === 'home'" @click="closeTab(context.value.id); context = null">{{ tr('关闭标签', 'Close tab') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="tabs.filter(tab => tab.kind !== 'home' && tab.id !== context.value.id).forEach(tab => closeTab(tab.id)); context = null">{{ tr('关闭其他标签', 'Close other tabs') }}</NButton>
        <NButton size="small" quaternary class="flat" @click="tabs.slice(1).forEach(tab => closeTab(tab.id)); context = null">{{ tr('关闭全部标签', 'Close all tabs') }}</NButton>
      </template>
    </div>

    <ConnectionDialog v-if="connectionDialog" :initial="connectionDialog.initial" :editing="connectionDialog.editing" :groups="groups" @save="saveConnection" @close="connectionDialog = null" />
    <WorkspaceDialog v-if="settingsOpen" @close="settingsOpen = false">
      <section class="modal" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h2>{{ tr('设置', 'Settings') }}</h2>
          <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭设置', 'Close settings')" @click="settingsOpen = false"><X :size="19" /></NButton>
        </header>
        <div class="modal-body form-grid">
          <fieldset class="preset-picker">
            <legend>{{ tr('配色方案', 'Color scheme') }}</legend>
            <NRadioGroup v-model:value="settings.scheme" name="color-scheme" :aria-label="tr('配色方案', 'Color scheme')" class="preset-options">
              <NRadioButton v-for="preset in themePresets" :key="preset.id" :value="preset.id">
                <span class="preset-option"><i aria-hidden="true" :style="{ background: preset[palette] }"></i>{{ tr(preset.zh, preset.en) }}</span>
              </NRadioButton>
            </NRadioGroup>
          </fieldset>
          <label>{{ tr('主题', 'Theme') }}<select v-model="settings.theme"><option value="system">{{ tr('跟随系统', 'System') }}</option><option value="light">{{ tr('浅色', 'Light') }}</option><option value="dark">{{ tr('深色', 'Dark') }}</option></select></label>
          <label>{{ tr('语言', 'Language') }}<select v-model="settings.language">
            <option value="zh">简体中文</option><option value="en">English</option>
          </select></label>
          <label>{{ tr('界面缩放', 'Interface zoom') }}<select v-model.number="settings.zoom"><option v-for="zoom in [85, 90, 100, 110, 120, 130]" :key="zoom" :value="zoom">{{ zoom }}%</option></select></label>
          <label><span id="workspace-font-label">{{ tr('界面字体', 'Interface font') }}</span>
            <NInput v-model:value="settings.font" :placeholder="tr('系统默认', 'System default')" :input-props="{ 'aria-labelledby': 'workspace-font-label' }" /></label>
          <label>{{ tr('每批加载键数', 'Keys per batch') }}<select v-model.number="settings.keyPageSize"><option v-for="count in keyPageSizes" :key="count" :value="count">{{ count }}</option></select></label>
          <div v-if="releaseConfig.version" class="update-settings">
            <span>{{ tr('当前版本', 'Current version') }} <strong>{{ releaseConfig.version }}</strong></span>
            <NButton size="small" v-if="releaseConfig.github" :disabled="checkingUpdates" @click="checkForUpdate(true)">
              {{ checkingUpdates ? tr('正在检查…', 'Checking…') : tr('检查更新', 'Check for updates') }}
            </NButton>
          </div>
        </div>
      </section>
    </WorkspaceDialog>
    <WorkspaceDialog v-if="shortcutsOpen" @close="shortcutsOpen = false">
      <section class="modal" role="dialog" aria-modal="true">
        <header class="modal-header"><h2>{{ tr('快捷键', 'Keyboard shortcuts') }}</h2><NButton size="small" quaternary class="flat icon" @click="shortcutsOpen = false"><X :size="19" /></NButton></header>
        <div class="modal-body shortcuts">
          <span>{{ tr('新建键或连接', 'New key or connection') }}</span><kbd>Ctrl + N</kbd>
          <span>{{ tr('搜索键', 'Search keys') }}</span><kbd>Ctrl + F</kbd>
          <span>{{ tr('命令行', 'Open CLI') }}</span><kbd>Ctrl + B</kbd>
          <span>{{ tr('关闭标签', 'Close tab') }}</span><kbd>Ctrl + W</kbd>
          <span>{{ tr('刷新键列表', 'Refresh keys') }}</span><kbd>Ctrl + R</kbd>
          <span>{{ tr('最大化', 'Toggle maximize') }}</span><kbd>Ctrl + Enter</kbd>
          <span>{{ tr('最小化', 'Minimize') }}</span><kbd>Ctrl + M</kbd>
        </div>
      </section>
    </WorkspaceDialog>
    <WorkspaceDialog v-if="question" @close="answer(false)">
      <form class="modal small-modal" role="dialog" aria-modal="true" @submit.prevent="answer(true)">
        <header class="modal-header"><h2>{{ question.title }}</h2></header>
        <div class="modal-body"><p v-if="question.text">{{ question.text }}</p><NInput v-if="question.input" v-model:value="question.value" :input-props="{ 'aria-label': question.title, autofocus: true }" /></div>
        <footer class="modal-footer end"><NButton size="small" @click="answer(false)">{{ tr('取消', 'Cancel') }}</NButton>
          <NButton :type="question.danger ? 'error' : 'primary'" attr-type="submit">{{ tr('确认', 'Confirm') }}</NButton></footer>
      </form>
    </WorkspaceDialog>
    <div v-if="message" class="toast" :class="{ error: message.error, success: message.success }" role="status">
      <CircleCheck v-if="message.success" :size="21" aria-hidden="true" />
      <span>{{ message.text }}</span>
      <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭提示', 'Dismiss notification')" @click="message = null"><X :size="16" /></NButton>
    </div>
  </div>
  </NConfigProvider>
</template>
