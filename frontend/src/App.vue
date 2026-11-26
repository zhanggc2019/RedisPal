<script setup>
import { computed, markRaw, nextTick, onMounted, onUnmounted, provide, reactive, ref, shallowReactive, watch } from 'vue'
import { darkTheme, enUS, NConfigProvider, zhCN } from 'naive-ui'
import {
  Activity, BookOpen, ChevronDown, ChevronRight, CircleCheck, CircleHelp, Database, Download, Ellipsis, Folder,
  FolderPlus, Info, Keyboard, List, ListChecks, Network, Plus, RefreshCw, Search, Server, Settings, Terminal, Trash2, Upload, X,
} from '@lucide/vue'
import { Application, Browser, call, desktopCall, Events, updateCall, Window } from './api.js'
import { asArg, createKeyTreeIndex, decodeBackup, display, download, identity, normalizeConnections, scanKeyBatches } from './model.js'
import { normalizeLanguage } from './locale.js'
import { tabName } from './tabs.js'
import { appearance, normalizePreset } from './theme.js'
import ConnectionDialog from './ConnectionDialog.vue'
import KeyTree from './KeyTree.vue'
import WorkspaceSidebar from './components/WorkspaceSidebar.vue'
import KeyPanel from './KeyPanel.vue'
import ServerPanel from './ServerPanel.vue'
import CliPanel from './CliPanel.vue'
import ToolsPanel from './ToolsPanel.vue'
import ProfilerPanel from './ProfilerPanel.vue'
import PubSubPanel from './PubSubPanel.vue'
import SearchPanel from './SearchPanel.vue'
import WorkspaceTabs from './components/WorkspaceTabs.vue'
import WorkspaceMenu from './components/WorkspaceMenu.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import HelpDialog from './components/HelpDialog.vue'
import ShortcutsDialog from './components/ShortcutsDialog.vue'

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
  theme: 'light', sidebar: 264, zoom: 100, recentConnections: [],
  ...savedSettings, language: normalizeLanguage(restored.settings?.language),
  font: typeof savedSettings.font === 'string' ? savedSettings.font : '',
  keyPageSize: keyPageSizes.includes(savedKeyPageSize) ? savedKeyPageSize : defaultKeyPageSize,
  scheme: normalizePreset(restored.settings?.scheme),
})
const sessions = reactive({})
const connectionErrors = reactive({})
const sidebarMode = ref('keys')
const viewportWidth = ref(innerWidth)
/** Preserve room for the workbench when the window or zoom reduces its logical width. */
const sidebarMax = computed(() => {
  const logicalWidth = viewportWidth.value / (settings.zoom / 100)
  return Math.max(224, Math.floor(logicalWidth * (logicalWidth < 720 ? .40 : .55)))
})
const tabs = ref([{ id: 'home', kind: 'home' }])
const activeId = ref('home')
const focusTabId = ref(null)
const active = computed(() => tabs.value.find(tab => tab.id === activeId.value) ?? tabs.value[0])
const tabNames = computed(() => Object.fromEntries(tabs.value.map(tab => [tab.id, tabName(tab, connections.value, tr)])))
const selectedId = ref('')
const connection = computed(() => connections.value.find(item => item.id === selectedId.value))
const session = computed(() => sessions[selectedId.value])
const hasMoreKeys = computed(() => Boolean(session.value?.cursor === null || session.value?.cursor || session.value?.pendingKeys?.length))
const connectionFilter = ref('')
const searchingConnections = ref(false)
const collapsedGroups = reactive(new Set())
const draggedConnection = ref(null)
const dropGroup = ref(null)
const connectionDialog = ref(null)
const settingsOpen = ref(false)
const helpSection = ref(null)
const closePrompt = ref(false)
const closeBusy = ref(false)
const releaseConfig = ref({ version: '', github: false })
const availableUpdate = ref(null)
const updateFeedback = ref(null)
const checkingUpdates = ref(false)
const updating = ref(false)
/** Describe the release both in the update dialog and on the Help indicator. */
const updateTitle = computed(() => {
  if (availableUpdate.value?.ready) return tr('更新已就绪，重启后生效', 'Update ready. Restart to apply.')
  if (updating.value && releaseConfig.value.signed) return tr('正在下载并验证更新…', 'Downloading and verifying update…')
  return tr('发现新版本', 'Update available')
})
/** Label the action that the current build can take for the release. */
const updateAction = computed(() => {
  if (availableUpdate.value?.ready) return tr('立即重启', 'Restart now')
  return releaseConfig.value.signed ? tr('安装更新', 'Install update') : tr('查看并下载', 'View and download')
})
const deferredRestart = ref(false)
const updatePending = computed(() => Boolean(availableUpdate.value && !deferredRestart.value))
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
let reportUpdateCheck = false
let stopCloseListener
let stopTrayQuitListener
let questionRevision = 0

/** Select the current interface language for a label. */
function tr(zh, en) {
  return settings.language === 'en' ? en : zh
}

/** Show the result of a server or workspace operation. */
function notify(text, error = false) {
  clearTimeout(messageTimer)
  message.value = { text: text?.message || String(text), error }
  messageTimer = setTimeout(() => { message.value = null }, error ? 8000 : 4200)
}

/** Read the build version and check its update feed in the background. */
async function startUpdateChecks() {
  releaseConfig.value = await updateCall('Configuration')
  if (!releaseConfig.value.github && !releaseConfig.value.signed) return
  void checkForUpdate(helpSection.value === 'updates')
  updateTimer = setInterval(checkForUpdate, 6 * 60 * 60 * 1000)
}

/** Check for a stable release and report a manual request that joins an existing check. */
async function checkForUpdate(manual = false) {
  if (updating.value) return
  if (manual) {
    reportUpdateCheck = true
    updateFeedback.value = null
  }
  if (checkingUpdates.value) return
  checkingUpdates.value = true
  try {
    const release = await updateCall('Check')
    if (!release.version) {
      availableUpdate.value = null
      if (reportUpdateCheck) updateFeedback.value = { text: tr('当前已是最新版本', 'You are up to date') }
    } else if (reportUpdateCheck || release.ready || release.version !== localStorage.getItem('ardm-dismissed-update')) {
      availableUpdate.value = release
      updateFeedback.value = null
      if (reportUpdateCheck) deferredRestart.value = false
    }
  } catch (error) {
    if (reportUpdateCheck) updateFeedback.value = { text: tr('检查更新失败', 'Could not check for updates') + ' · ' + (error.message || String(error)), error: true }
  } finally {
    reportUpdateCheck = false
    checkingUpdates.value = false
  }
}

/** Hide the automatic prompt for this release until a newer version is published. */
function dismissUpdate() {
  localStorage.setItem('ardm-dismissed-update', availableUpdate.value.version)
  availableUpdate.value = null
  updateFeedback.value = null
}

/** Apply the current update action while leaving its result beside the release. */
async function openUpdate() {
  const release = availableUpdate.value
  if (!release || checkingUpdates.value || updating.value) return
  updateFeedback.value = null
  updating.value = true
  try {
    if (release.ready) {
      if (tabs.value.some(tab => tab.dirty)) helpSection.value = null
      if (await confirmDiscard(tabs.value)) await updateCall('RestartUpdate')
    } else if (releaseConfig.value.signed) {
      await updateCall('PrepareUpdate', release.version)
      availableUpdate.value = { ...release, ready: true }
    } else {
      await Browser.OpenURL(release.url)
    }
  } catch (error) {
    updateFeedback.value = { text: tr('更新失败', 'Update failed') + ' · ' + (error.message || String(error)), error: true }
  } finally {
    updating.value = false
  }
}

/** Open a Help command and immediately check the feed when requested. */
function openHelp(section) {
  context.value = null
  helpSection.value = section
  if (section === 'updates' && (releaseConfig.value.github || releaseConfig.value.signed)) void checkForUpdate(true)
}

/** Ask for a value or explicit destructive-action confirmation inside the desktop window. */
function ask(options) {
  if (question.value) return Promise.resolve(null)
  return new Promise(resolve => {
    question.value = { id: ++questionRevision, input: false, value: '', ...options, resolve }
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
provide('confirmDiscard', confirmDiscard)

async function confirmDiscard(candidates) {
  const dirty = candidates.filter(tab => tab.dirty)
  if (!dirty.length) return true
  return Boolean(await ask({
    title: tr('放弃未保存的修改？', 'Discard unsaved changes?'),
    text: dirty.map(tab => tabNames.value[tab.id]).join('\n'),
    confirmLabel: tr('放弃修改', 'Discard changes'),
    danger: true,
  }))
}
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
const selectedKeys = computed(() => session.value?.keys.filter(key => session.value.selected.has(identity(key))) || [])
const recentConnections = computed(() => (Array.isArray(settings.recentConnections) ? settings.recentConnections : [])
  .map(id => connections.value.find(item => item.id === id && !item.temporary)).filter(Boolean))
const connectingOrClosing = new Set()

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
    if (sessions[item.id] && !await disconnect(item.id)) return
    connections.value[index] = item
  }
  connectionDialog.value = null
}

/** Open a saved server and populate its database selector and first key page. */
async function connect(item) {
  selectedId.value = item.id
  if (connectingOrClosing.has(item.id)) return
  if (sessions[item.id]) {
    if (!sessions[item.id].connecting) openTab({ kind: 'server', connection: item.id })
    return
  }
  connectingOrClosing.add(item.id)
  delete connectionErrors[item.id]
  sessions[item.id] = { connecting: true }
  try {
    const started = performance.now()
    await call('Connect', item.id, item)
    const latency = Math.round(performance.now() - started)
    const info = await call('Info', item.id, 0)
    const db = info.databases.includes(item.lastDb) ? item.lastDb : 0
    sessions[item.id] = {
      connecting: false, latency, db, info, keys: shallowReactive([]), pendingKeys: shallowReactive([]), cursor: '', query: '', exact: false,
      tree: Boolean(item.separator), keyIndex: null, expanded: new Set(), selected: new Set(), seen: markRaw(new Set()),
      multi: false, loading: false, revision: 0, sorting: false,
      history: item.searchHistory || [],
    }
    if (!item.temporary) settings.recentConnections = [item.id, ...recentConnections.value.map(entry => entry.id).filter(id => id !== item.id)].slice(0, 5)
    if (selectedId.value === item.id) openTab({ kind: 'server', connection: item.id })
    void scan(item.id, true)
  } catch (error) {
    await call('Disconnect', item.id).catch(() => {})
    delete sessions[item.id]
    connectionErrors[item.id] = error.message || String(error)
  } finally {
    connectingOrClosing.delete(item.id)
  }
}

/** Close the server's tabs before dropping its backend session. */
async function disconnect(id) {
  context.value = null
  if (connectingOrClosing.has(id)) return false
  connectingOrClosing.add(id)
  try {
    const closing = tabs.value.filter(tab => tab.connection === id)
    if (!await confirmDiscard(closing)) return false
    if (sessions[id]) {
      sessions[id].closing = true
      await call('Disconnect', id)
    }
    delete sessions[id]
    delete connectionErrors[id]
    removeTabs(closing)
    return true
  } catch (error) {
    notify(error, true)
    return false
  } finally {
    if (sessions[id]) sessions[id].closing = false
    connectingOrClosing.delete(id)
  }
}

/** Remove only the saved profile after explicit confirmation. */
async function removeConnection(item) {
  context.value = null
  if (!await ask({ title: tr('删除连接', 'Delete connection'), text: item.name, danger: true })) return
  if (!await disconnect(item.id)) return
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

function indexKeys(state, separator, keys) {
  const index = state.tree && separator ? markRaw(createKeyTreeIndex(separator)) : null
  index?.append(keys)
  state.keyIndex = index
}

/** Fill one key-list batch and carry overflow from Redis SCAN into subsequent batches. */
async function scan(id, reset = false, all = false) {
  const state = sessions[id]
  if (!state || state.connecting || (state.loading && !reset) || (!reset && state.cursor === '' && !state.pendingKeys.length)) return
  const { separator } = connections.value.find(item => item.id === id)
  if (reset) {
    indexKeys(state, separator, [])
    state.selected.clear()
  }
  const revision = ++state.revision
  const isCurrent = () => revision === state.revision && sessions[id] === state
  const { db, query, exact } = state
  const pageSize = settings.keyPageSize
  const limit = all ? Infinity : (reset ? 0 : state.keys.length) + pageSize
  state.loading = true
  const pattern = exact ? query : (!query ? '*' : /[*?\[\\]/.test(query) ? query : '*' + query + '*')
  try {
    await scanKeyBatches(state, limit, reset, cursor => {
      const request = call('Scan', id, db, pattern, cursor, exact, pageSize)
      state.scanRequest = request
      return request
    }, isCurrent)
  } catch (error) {
    if (isCurrent()) notify(error, true)
  } finally {
    if (isCurrent()) {
      state.scanRequest = null
      if (state.sorting) {
        state.keys = shallowReactive(state.keys.slice().sort((a, b) => display(a).localeCompare(display(b))))
        indexKeys(state, separator, state.keys)
      }
      state.loading = false
    }
  }
}

function stopScan() {
  const state = session.value
  const request = state.scanRequest
  state.revision++
  state.loading = false
  state.scanRequest = null
  void request?.cancel()
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
  const state = session.value
  state.tree = !state.tree
  indexKeys(state, connection.value.separator, state.keys)
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
  if (sessions[data.connection]?.closing) return
  if (!tabs.value.some(tab => tab.id === id)) tabs.value.push({ id, ...data })
  activateTab(id)
}

/** Activate a workspace tab and restore the corresponding sidebar connection. */
function activateTab(id) {
  activeId.value = id
  const tab = tabs.value.find(item => item.id === id)
  if (tab?.connection) selectedId.value = tab.connection
}

async function closeTabs(ids) {
  context.value = null
  const closing = tabs.value.filter(tab => tab.kind !== 'home' && ids.includes(tab.id))
  if (await confirmDiscard(closing)) removeTabs(closing)
}

function closeTab(id) {
  return closeTabs([id])
}

function removeTabs(closing) {
  const removed = new Set(closing)
  const index = tabs.value.findIndex(tab => removed.has(tab) && tab.id === activeId.value)
  const pivot = index < 0 ? tabs.value.findIndex(tab => removed.has(tab)) : index
  if (pivot < 0) return
  const neighbour = tabs.value.slice(0, pivot).findLast(tab => !removed.has(tab))
    ?? tabs.value.slice(pivot + 1).find(tab => !removed.has(tab))
  tabs.value = tabs.value.filter(tab => !removed.has(tab))
  if (index >= 0 && neighbour) activateTab(neighbour.id)
  focusTabId.value = neighbour?.id || null
}

/** Clear a focus request only after WorkspaceTabs has focused its target. */
function databaseTabs(id, db, keys) {
  return tabs.value.filter(tab => tab.kind === 'key' && tab.connection === id && tab.db === db && (!keys || keys.has(identity(tab.key))))
}

function clearTabFocus(id) {
  if (focusTabId.value === id) focusTabId.value = null
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
    if (tab.kind === 'new' || identity(key) !== identity(tab.key)) removeTabs([tab])
  } else removeTabs([tab])
  if (state && state.db === tab.db) scan(tab.connection, true)
}

/** Open a server-side tools tab on the currently selected database. */
function openTool(kind, fresh = false) {
  context.value = null
  if (!session.value || session.value.connecting) return
  if (kind === 'new' && connection.value?.readOnly) return
  if (kind === 'server') openTab({ kind, connection: selectedId.value })
  else openTab({ kind, connection: selectedId.value, db: session.value.db }, fresh)
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
  if (!file || !session.value || session.value.connecting || connection.value?.readOnly) return
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
  if (!session.value || session.value.connecting || connection.value?.readOnly) return
  const keys = selectedKeys.value
  const id = selectedId.value
  const db = session.value.db
  const closing = databaseTabs(id, db, new Set(keys.map(identity)))
  if (!keys.length || !await ask({ title: tr('批量删除键', 'Delete selected keys'), text: 'DB ' + db + ' · ' + keys.length + tr(' 个键', ' keys'), danger: true }) || !await confirmDiscard(closing)) return
  try {
    const result = await call('Delete', id, db, keys.map(asArg))
    if (!result.errors.length) removeTabs(closing)
    notify(tr('已删除键', 'Keys deleted') + ' · ' + result.imported + (result.errors.length ? '\n' + result.errors[0] : ''), result.errors.length > 0)
    if (sessions[id]?.db === db) await scan(id, true)
  } catch (error) {
    notify(error, true)
  }
}

/** Clear exactly one selected database after requiring its displayed name to be typed. */
async function flushDatabase() {
  context.value = null
  if (!session.value || session.value.connecting || connection.value?.readOnly) return
  const id = selectedId.value
  const db = session.value.db
  const closing = databaseTabs(id, db)
  const name = connection.value.name
  const confirmation = 'DB ' + db
  const text = tr('此操作将删除该数据库中的所有键。输入 ', 'This deletes all keys in the selected database. Type ') + confirmation
  const result = await ask({ title: tr('清空数据库', 'Flush database'), text: name + '\n' + text, input: true, danger: true })
  if (result === null) return
  if (result.trim() !== confirmation) return notify(tr('确认文本不匹配', 'Confirmation text did not match'), true)
  if (!await confirmDiscard(closing)) return
  try {
    await call('Flush', id, db)
    removeTabs(closing)
    if (sessions[id]?.db === db) await scan(id, true)
    notify(tr('数据库已清空', 'Database cleared'))
  } catch (error) {
    notify(error, true)
  }
}

/** Anchor footer Help above its button and other workspace menus at their trigger. */
function menu(event, kind, value) {
  const anchor = event.target.closest?.('button') || event.currentTarget.querySelector('button') || document.activeElement
  const bounds = anchor?.getBoundingClientRect()
  if (kind === 'help' && bounds) {
    context.value = { x: bounds.right, y: bounds.top, kind, anchor, placement: 'top-end' }
    return
  }
  const keyboard = !event.clientX && !event.clientY
  context.value = { x: keyboard ? bounds?.left ?? 4 : event.clientX, y: keyboard ? bounds?.bottom ?? 4 : event.clientY, kind, value, anchor }
}

/** Keep the two-panel layout usable while resizing the left pane. */
function resize(event) {
  const grip = event.currentTarget
  grip.setPointerCapture(event.pointerId)
  grip.onpointermove = move => { settings.sidebar = clampSidebar(move.clientX / (settings.zoom / 100)) }
  grip.onlostpointercapture = () => { grip.onpointermove = null }
}

function clampSidebar(width) {
  return Math.round(Math.min(Math.max(width, 224), sidebarMax.value))
}

function resizeByKey(event) {
  const width = clampSidebar(settings.sidebar)
  const targets = { ArrowLeft: width - 8, ArrowRight: width + 8, Home: 224, End: sidebarMax.value }
  if (!Object.hasOwn(targets, event.key)) return
  event.preventDefault()
  settings.sidebar = clampSidebar(targets[event.key])
}

function updateViewport() {
  viewportWidth.value = innerWidth
}

/** Update theme when Windows changes color mode. */
function systemTheme(event) {
  systemDark.value = event.matches
}

/** Display the close prompt for a native title bar or keyboard close request. */
function confirmWindowClose() {
  closePrompt.value = true
}

/** Cancel the close request unless the application is handling a choice. */
function cancelWindowClose() {
  if (!closeBusy.value) closePrompt.value = false
}

/** Run the selected native close action and report failures in the workspace. */
async function finishWindowClose(toTray) {
  if (closeBusy.value || question.value) return
  if (!toTray && !await confirmDiscard(tabs.value)) return
  closeBusy.value = true
  try {
    if (toTray) await desktopCall('MinimiseToTray', tr('打开 RedisPal', 'Open RedisPal'), tr('退出 RedisPal', 'Quit RedisPal'))
    else await Application.Quit()
    closePrompt.value = false
  } catch (error) {
    notify(error, true)
  } finally {
    closeBusy.value = false
  }
}

/** Dispatch the desktop keyboard shortcuts from any active panel. */
function shortcut(event) {
  if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey)) return
  if (event.target instanceof Element && (event.target.closest('input, textarea, select, [role="dialog"]') || event.target.isContentEditable)) return
  if (question.value || closePrompt.value) return
  const key = event.key.toLowerCase()
  const actions = {
    n: () => session.value && !session.value.connecting && !connection.value.readOnly ? openTool('new', true) : editConnection(),
    f: async () => { sidebarMode.value = 'keys'; await nextTick(); searchInput.value?.focus() },
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
  window.addEventListener('resize', updateViewport)
  stopCloseListener = Events.On('redispal:close-requested', confirmWindowClose)
  stopTrayQuitListener = Events.On('redispal:tray-quit-requested', () => finishWindowClose(false))
  desktopCall('ReadyForCloseRequests').then(pending => { if (pending) confirmWindowClose() }).catch(error => notify(error, true))
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
  window.removeEventListener('resize', updateViewport)
  stopCloseListener?.()
  stopTrayQuitListener?.()
  clearTimeout(messageTimer)
  clearInterval(updateTimer)
})
</script>

<template>
  <NConfigProvider abstract :theme="palette === 'dark' ? darkTheme : null" :theme-overrides="activeTheme.naive" :locale="settings.language === 'zh' ? zhCN : enUS">
  <div class="app" :data-theme="palette" :data-scheme="settings.scheme"
    :style="{ ...activeTheme.css, '--sidebar-width': clampSidebar(settings.sidebar) + 'px', '--ui-scale': settings.zoom / 100, '--workspace-font': settings.font || undefined }"
    @click="context = null">
    <WorkspaceSidebar v-model:mode="sidebarMode" :connected="Boolean(session && !session.connecting)" @tool="kind => openTool(kind, kind === 'cli')">
      <template #header>
      <header class="brand"><img src="/logo.png" class="app-logo" alt=""><div><strong>RedisPal</strong></div>
        <NButton size="small" quaternary class="flat icon" :title="tr('设置', 'Settings')" :aria-label="tr('设置', 'Settings')" @click="settingsOpen = true"><Settings :size="17" /></NButton>
      </header>
      <div class="connection-actions">
        <NButton size="medium" type="primary" class="primary add-connection" :aria-label="tr('新建连接', 'New connection')"
          :title="tr('新建连接', 'New connection')" @click="editConnection()"><Plus :size="17" /><span class="add-connection-label">{{ tr('新建连接', 'New connection') }}</span></NButton>
        <NButton size="small" class="icon" :title="tr('连接管理', 'Manage connections')" :aria-label="tr('连接管理', 'Manage connections')" aria-haspopup="menu" :aria-expanded="context?.kind === 'workspace'" @click.stop="menu($event, 'workspace')"><Ellipsis :size="18" /></NButton>
      </div>
      </template>
      <template #connections>
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
            <NButton size="small" quaternary class="flat icon row-menu" :title="tr('分组操作', 'Group actions')" aria-haspopup="menu" :aria-expanded="context?.kind === 'group' && context.value.id === group.id" @click.stop="menu($event, 'group', group)"><Ellipsis :size="15" /></NButton>
          </div>
          <h3 v-else-if="groups.length" class="ungrouped-heading">{{ group.name }}</h3>
          <div v-if="group.connections.length && (!collapsedGroups.has(group.id) || connectionFilter)" :class="{ 'group-children': group.id }">
            <template v-for="item in group.connections" :key="item.id">
            <div class="connection-row" :class="{ current: item.id === selectedId, dragging: draggedConnection?.id === item.id }"
              draggable="true" @dragstart="startConnectionDrag($event, item)" @dragend="endConnectionDrag" @contextmenu.prevent.stop="menu($event, 'connection', item)">
              <NButton size="small" quaternary class="flat connection-name" :title="item.addr" @click="connect(item)"
                :aria-description="sessions[item.id]?.connecting ? tr('正在连接', 'Connecting') : sessions[item.id] ? tr('已连接', 'Connected') : connectionErrors[item.id] ? tr('连接失败', 'Connection failed') : tr('未连接', 'Disconnected')">
                <Server :size="16" :style="{ color: item.color || undefined }" aria-hidden="true" /><span>{{ item.name }}</span>
                <span v-if="sessions[item.id]?.connecting" class="dot pending" aria-hidden="true"></span>
                <CircleCheck v-else-if="sessions[item.id]" class="connection-check" :size="14" aria-hidden="true" />
              </NButton>
              <NButton size="small" quaternary class="flat icon row-menu" :aria-label="tr('连接操作', 'Connection actions')" aria-haspopup="menu" :aria-expanded="context?.kind === 'connection' && context.value.id === item.id" @click.stop="menu($event, 'connection', item)"><Ellipsis :size="16" /></NButton>
            </div>
            <div v-if="sessions[item.id]?.connecting" role="status" class="connection-state">{{ tr('正在连接…', 'Connecting…') }}</div>
            <div v-else-if="connectionErrors[item.id]" class="connection-state">
              <span role="alert">{{ connectionErrors[item.id] }}</span>
              <NButton size="small" @click="connect(item)">{{ tr('重试', 'Retry') }}</NButton>
            </div>
            </template>
          </div>
        </div>
      </section>
      </template>
      <template #database>
        <div class="db-bar">
          <div class="db-select"><Database :size="16" /><select :value="session.db" :aria-label="tr('数据库', 'Database')" @change="selectDatabase(Number($event.target.value))">
            <option v-for="db in session.info.databases" :key="db" :value="db">DB {{ db }}{{ connection.dbNames?.[db] ? ' · ' + connection.dbNames[db] : '' }}</option>
          </select></div>
          <NButton size="small" class="icon db-shortcut" :title="tr('服务器状态', 'Server status')" @click="openTool('server')"><Activity :size="16" /></NButton>
          <NButton size="small" class="icon db-shortcut" :title="tr('打开命令行', 'Open CLI')" @click="openTool('cli', true)"><Terminal :size="17" /></NButton>
          <NButton size="small" class="icon" :aria-label="tr('数据库操作', 'Database actions')" aria-haspopup="menu" :aria-expanded="context?.kind === 'database'" @click.stop="menu($event, 'database')"><Ellipsis :size="17" /></NButton>
        </div>
      </template>
      <template #keys>
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
          <KeyTree :nodes="session.keyIndex?.nodes" :keys="session.keyIndex ? undefined : session.keys"
            :key-count="session.keys.length" :expanded="session.expanded" :selected="session.selected"
            :active="active.kind === 'key' && active.connection === selectedId && active.db === session.db ? identity(active.key) : ''"
            :multi="session.multi" @open="openKey" @toggle="toggleFolder" @check="checkKey" />
          <div v-if="!session.keys.length && !session.loading && !hasMoreKeys" class="empty-side">{{ tr('没有匹配的键', 'No matching keys') }}</div>
        </div>
        <div v-if="hasMoreKeys || session.loading" class="paging">
          <template v-if="session.loading">
            <NButton size="small" disabled>{{ tr('正在扫描…', 'Scanning…') }}</NButton>
            <NButton size="small" @click="stopScan">{{ tr('停止加载', 'Stop loading') }}</NButton>
          </template>
          <template v-else>
            <NButton size="small" @click="scan(selectedId)">{{ tr('加载更多', 'Load more') }}</NButton>
            <NButton size="small" @click="scan(selectedId, false, true)">{{ tr('全部加载', 'Load all') }}</NButton>
          </template>
        </div>
      </template>
      <template #footer>
      <footer class="sidebar-footer">
        <span role="status" aria-atomic="true">
          <template v-if="session && !session.connecting"><i class="dot" aria-hidden="true"></i>{{ tr('已连接', 'Connected') }} · {{ session.latency }} ms</template>
          <template v-else-if="session?.connecting">{{ tr('正在连接…', 'Connecting…') }}</template>
          <template v-else-if="connectionErrors[selectedId]">{{ tr('连接失败', 'Connection failed') }}</template>
          <template v-else>{{ tr('未连接', 'Disconnected') }}</template>
        </span>
        <NButton size="small" quaternary class="flat" aria-haspopup="menu" :aria-expanded="context?.kind === 'help'"
          :aria-description="updatePending ? updateTitle : undefined" @click.stop="context?.kind === 'help' ? context = null : menu($event, 'help')">
          <CircleHelp :size="16" aria-hidden="true" />{{ tr('帮助', 'Help') }}<span v-if="updatePending" class="help-update-dot" aria-hidden="true"></span>
        </NButton>
      </footer>
      </template>
    </WorkspaceSidebar>
    <div class="resize-grip" role="separator" aria-orientation="vertical" aria-controls="workspace-sidebar" tabindex="0"
      :aria-label="tr('调整侧栏宽度', 'Resize sidebar')" :aria-valuemin="224" :aria-valuemax="sidebarMax" :aria-valuenow="clampSidebar(settings.sidebar)"
      @pointerdown.prevent="resize" @keydown="resizeByKey"></div>
    <main class="workbench">
      <WorkspaceTabs :tabs="tabs" :active-id="activeId" :focus-tab-id="focusTabId" :names="tabNames"
        @activate="activateTab" @close="closeTab" @menu="(event, tab) => menu(event, 'tab', tab)"
        @focus-request-complete="clearTabFocus" />
      <section v-show="active.kind === 'home'" id="workspace-panel-0" class="home" role="tabpanel" aria-labelledby="workspace-tab-0">
        <div class="home-content">
          <div class="home-intro">
            <img src="/logo.png" alt="" class="app-logo home-logo">
            <div>
              <h1>RedisPal</h1>
              <p>{{ tr('打开已有连接，或添加一个 Redis 服务器。', 'Open a saved connection or add a Redis server.') }}</p>
            </div>
          </div>
          <div class="home-actions">
            <NButton type="primary" size="small" class="primary" @click="editConnection()"><Plus :size="16" />{{ tr('新建连接', 'New connection') }}</NButton>
            <NButton size="small" @click="fileInput.click()"><Upload :size="15" />{{ tr('导入连接', 'Import connections') }}</NButton>
          </div>
          <section v-if="recentConnections.length" class="home-section">
            <h2>{{ tr('最近使用的连接', 'Recent connections') }}</h2>
            <NButton v-for="item in recentConnections" :key="item.id" size="small" quaternary class="flat recent-connection"
              :aria-label="tr('打开连接', 'Open connection') + ' · ' + item.name" @click="connect(item)">
              <Server :size="15" aria-hidden="true" /><span>{{ item.name }}</span><small>{{ item.addr }}</small>
            </NButton>
          </section>
          <section v-if="session && !session.connecting" class="home-section">
            <h2>{{ tr('常用工具', 'Common tools') }}</h2>
            <div class="home-actions">
              <NButton size="small" @click="openTool('server')">{{ tr('服务器概览', 'Server overview') }}</NButton>
              <NButton size="small" @click="openTool('cli', true)">Redis CLI</NButton>
            </div>
          </section>
        </div>
      </section>
      <template v-for="(tab, index) in tabs" :key="tab.id">
        <section v-if="tab.connection && sessions[tab.connection] && !sessions[tab.connection].connecting" v-show="activeId === tab.id"
          :id="`workspace-panel-${index}`" class="tab-panel" role="tabpanel" :aria-labelledby="`workspace-tab-${index}`" :inert="sessions[tab.connection].closing || undefined">
          <ServerPanel v-if="tab.kind === 'server'" :visible="activeId === tab.id" :connection="connections.find(item => item.id === tab.connection)" :db="sessions[tab.connection].db" :info="sessions[tab.connection].info"
            @info="info => { if (sessions[tab.connection]) sessions[tab.connection].info = info }" />
          <KeyPanel v-else-if="tab.kind === 'key' || tab.kind === 'new'" :tab="tab" :connection="connections.find(item => item.id === tab.connection)" :visible="activeId === tab.id"
            @dirty="tab.dirty = $event" @change="key => keyChanged(tab, key)" @refresh-list="scan(tab.connection, true)" @open-key="key => openTab({ kind: 'key', connection: tab.connection, db: tab.db, key })" />
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

    <WorkspaceMenu v-if="context" :context="context" :label="context.kind === 'help' ? tr('帮助', 'Help') : tr('工作区操作', 'Workspace actions')" @close="context = null">
      <template v-if="context.kind === 'help'">
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="openHelp('guide')"><BookOpen :size="15" aria-hidden="true" />{{ tr('使用帮助', 'User guide') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="context = null; shortcutsOpen = true"><Keyboard :size="15" aria-hidden="true" />{{ tr('快捷键', 'Keyboard shortcuts') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="openHelp('updates')"><RefreshCw :size="15" aria-hidden="true" />{{ tr('检查更新', 'Check for updates') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="openHelp('about')"><Info :size="15" aria-hidden="true" />{{ tr('关于 RedisPal', 'About RedisPal') }}</NButton>
      </template>
      <template v-else-if="context.kind === 'workspace'">
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="editGroup()"><FolderPlus :size="16" />{{ tr('新建分组', 'New group') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="context = null; fileInput.click()"><Upload :size="15" />{{ tr('导入连接', 'Import connections') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="context = null; exportConnections()"><Download :size="15" />{{ tr('导出连接', 'Export connections') }}</NButton>
      </template>
      <template v-else-if="context.kind === 'connection'">
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="editConnection(context.value)">{{ tr('编辑连接', 'Edit connection') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="editConnection(context.value, true)">{{ tr('克隆连接', 'Clone connection') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="moveConnection(context.value, -1)">{{ tr('上移', 'Move up') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="moveConnection(context.value, 1)">{{ tr('下移', 'Move down') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary v-if="sessions[context.value.id]" class="flat" :disabled="sessions[context.value.id].connecting" @click="disconnect(context.value.id)">{{ tr('断开连接', 'Disconnect') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary type="error" class="flat danger" @click="removeConnection(context.value)">{{ tr('删除连接', 'Delete connection') }}</NButton>
      </template>
      <template v-else-if="context.kind === 'group'">
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="editGroup(context.value)">{{ tr('重命名分组', 'Rename group') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary type="error" class="flat danger" @click="removeGroup(context.value)">{{ tr('删除分组', 'Delete group') }}</NButton>
      </template>
      <template v-else-if="context.kind === 'database'">
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="openTool('server')"><Activity :size="15" />{{ tr('服务器状态', 'Server status') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="openTool('cli', true)"><Terminal :size="15" />{{ tr('打开命令行', 'Open CLI') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="context = null; nameDatabase()">{{ tr('命名数据库', 'Name database') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="context = null; session.sorting = !session.sorting; scan(selectedId, true)">{{ session.sorting ? tr('按扫描顺序', 'Order by scan') : tr('按名称排序', 'Sort by name') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="context = null; exportKeys()">{{ tr('导出键', 'Export keys') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" :disabled="connection.readOnly" @click="context = null; backupInput.click()">{{ tr('导入键', 'Import keys') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary type="error" class="flat danger" :disabled="connection.readOnly" @click="flushDatabase">{{ tr('清空数据库', 'Flush database') }}</NButton>
      </template>
      <template v-else-if="context.kind === 'tab'">
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" :disabled="context.value.kind === 'home'" @click="closeTab(context.value.id)">{{ tr('关闭标签', 'Close tab') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="closeTabs(tabs.filter(tab => tab.id !== context.value.id).map(tab => tab.id))">{{ tr('关闭其他标签', 'Close other tabs') }}</NButton>
        <NButton size="small" role="menuitem" tabindex="-1" quaternary class="flat" @click="closeTabs(tabs.map(tab => tab.id))">{{ tr('关闭全部标签', 'Close all tabs') }}</NButton>
      </template>
    </WorkspaceMenu>

    <ConnectionDialog v-if="connectionDialog" :initial="connectionDialog.initial" :editing="connectionDialog.editing" :groups="groups" @save="saveConnection" @close="connectionDialog = null" />
    <SettingsDialog v-if="settingsOpen" :settings="settings" :palette="palette" :key-page-sizes="keyPageSizes" @close="settingsOpen = false" />
    <HelpDialog v-if="helpSection" :section="helpSection" :release="releaseConfig" :available-update="availableUpdate"
      :update-feedback="updateFeedback" :update-title="updateTitle" :update-action="updateAction" :checking="checkingUpdates" :updating="updating"
      @check="checkForUpdate(true)" @apply-update="openUpdate" @dismiss-update="dismissUpdate"
      @defer-restart="deferredRestart = true; helpSection = null" @close="helpSection = null" />
    <ShortcutsDialog v-if="shortcutsOpen" @close="shortcutsOpen = false" />
    <WorkspaceDialog v-if="question" :title-id="'question-title-' + question.id" :description-id="question.text ? 'question-description-' + question.id : undefined" @close="answer(false)">
      <template #default="{ requestClose, titleId, descriptionId }">
        <form class="modal small-modal" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId" @submit.prevent="answer(true)">
          <header class="modal-header"><h2 :id="titleId">{{ question.title }}</h2></header>
          <div class="modal-body"><p v-if="question.text" :id="descriptionId">{{ question.text }}</p><NInput v-if="question.input" v-model:value="question.value" :input-props="{ 'aria-label': question.title, autofocus: true }" /></div>
          <footer class="modal-footer end"><NButton size="small" @click="requestClose">{{ tr('取消', 'Cancel') }}</NButton>
            <NButton :type="question.danger ? 'error' : 'primary'" attr-type="submit">{{ question.confirmLabel || tr('确认', 'Confirm') }}</NButton></footer>
        </form>
      </template>
    </WorkspaceDialog>
    <WorkspaceDialog v-if="closePrompt && !question" title-id="close-window-title" description-id="close-window-description" :busy="closeBusy" @close="cancelWindowClose">
      <template #default="{ requestClose, closeDisabled }">
        <section class="modal small-modal" role="dialog" aria-modal="true" aria-labelledby="close-window-title" aria-describedby="close-window-description">
          <header class="modal-header"><h2 id="close-window-title">{{ tr('关闭 RedisPal', 'Close RedisPal') }}</h2></header>
          <div class="modal-body"><p id="close-window-description">{{ tr('退出程序，或放到系统托盘并保留当前连接。', 'Quit the app or keep your connections open in the system tray.') }}</p></div>
          <footer class="modal-footer end">
            <NButton size="small" :disabled="closeDisabled" @click="requestClose">{{ tr('取消', 'Cancel') }}</NButton>
            <NButton size="small" :disabled="closeBusy" @click="finishWindowClose(false)">{{ tr('退出程序', 'Quit the app') }}</NButton>
            <NButton size="small" type="primary" :disabled="closeBusy" @click="finishWindowClose(true)">{{ tr('最小化到托盘', 'Minimise to tray') }}</NButton>
          </footer>
        </section>
      </template>
    </WorkspaceDialog>
    <div v-if="message" class="toast" :class="{ error: message.error }" role="status">
      <span>{{ message.text }}</span>
      <NButton size="small" quaternary class="flat icon" :aria-label="tr('关闭提示', 'Dismiss notification')" @click="message = null"><X :size="16" /></NButton>
    </div>
  </div>
  </NConfigProvider>
</template>
