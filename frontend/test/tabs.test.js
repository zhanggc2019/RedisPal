import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import postcss from 'postcss'
import { Activity, Database, KeyRound, Radio, Search, Terminal } from '@lucide/vue'
import { nextTabIndex, tabIcon, tabName } from '../src/tabs.js'

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  plugins: [vue()],
  server: { middlewareMode: true },
  appType: 'custom',
})
test.after(() => server.close())

test('tab keyboard navigation wraps at both ends', () => {
  assert.equal(nextTabIndex(2, 3, 'ArrowRight'), 0)
  assert.equal(nextTabIndex(0, 3, 'ArrowLeft'), 2)
  assert.equal(nextTabIndex(1, 3, 'End'), 2)
})

test('vertical arrows navigate tabs like horizontal arrows', () => {
  assert.equal(nextTabIndex(1, 3, 'ArrowDown'), 2)
  assert.equal(nextTabIndex(0, 3, 'ArrowUp'), 2)
})

test('Home and End move to the first and last tabs', () => {
  assert.equal(nextTabIndex(2, 3, 'Home'), 0)
  assert.equal(nextTabIndex(0, 3, 'End'), 2)
})

test('unrelated keys retain the current tab', () => {
  assert.equal(nextTabIndex(1, 3, 'Enter'), 1)
  assert.equal(nextTabIndex(1, 3, 'a'), 1)
})

test('an empty tab strip has no navigable index', () => {
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
    assert.equal(nextTabIndex(0, 0, key), -1)
  }
})

test('tab icons identify each workspace kind', () => {
  assert.equal(tabIcon('home'), Database)
  assert.equal(tabIcon('key'), KeyRound)
  assert.equal(tabIcon('new'), KeyRound)
  assert.equal(tabIcon('cli'), Terminal)
  assert.equal(tabIcon('pubsub'), Radio)
  assert.equal(tabIcon('search'), Search)
  assert.equal(tabIcon('server'), Activity)
  assert.equal(tabIcon('profiler'), Activity)
})

test('tab names use connection context, translations, and binary-safe keys', () => {
  const connections = [{ id: 'redis-1', name: 'Cache' }]
  const tr = (zh, en) => en
  assert.equal(tabName({ kind: 'home' }, connections, tr), 'Workspace')
  assert.equal(tabName({ kind: 'server', connection: 'redis-1' }, connections, tr), 'Cache')
  assert.equal(tabName({ kind: 'cli', connection: 'redis-1' }, connections, tr), 'CLI · Cache')
  assert.equal(tabName({ kind: 'key', key: { hex: '00ff' } }, connections, tr), '0x00ff')
  assert.equal(tabName({ kind: 'new' }, connections, tr), 'New key')
  assert.equal(tabName({ kind: 'profiler' }, connections, tr), 'Profiler')
  assert.equal(tabName({ kind: 'memory' }, connections, tr), 'Memory analysis')
  assert.equal(tabName({ kind: 'search' }, connections, tr), 'Redis Search')
})

test('workspace tabs render native controls, type icons, and an accessible dirty state', async () => {
  const { default: WorkspaceTabs } = await server.ssrLoadModule('/src/components/WorkspaceTabs.vue')
  const app = createSSRApp(defineComponent({
    render: () => h(WorkspaceTabs, {
      tabs: [{ id: 'home', kind: 'home' }, { id: 'key', kind: 'key', dirty: true }],
      activeId: 'key',
      names: { home: 'Workspace', key: 'profile' },
    }),
  }))
  app.provide('tr', (zh, en) => en)
  const html = await renderToString(app)

  assert.match(html, /role="tablist"/)
  assert.match(html, /aria-label="Workspace tabs"/)
  assert.match(html, /<button[^>]*type="button"[^>]*role="tab"[^>]*aria-selected="false"[^>]*tabindex="-1"/)
  assert.match(html, /<button[^>]*type="button"[^>]*role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"/)
  assert.match(html, /aria-label="profile, unsaved changes"/)
  assert.match(html, /class="tab-dirty" aria-hidden="true"/)
  assert.match(html, /lucide-key-round/)
  assert.doesNotMatch(html, /class="[^"]*n-button/)
  assert.equal((html.match(/aria-label="Close tab"/g) || []).length, 1)
})

test('the workspace tab strip keeps its 38px compact height', async () => {
  const { default: css } = await server.ssrLoadModule('/src/style.css?inline')
  const declarations = {}
  postcss.parse(css).walkRules(rule => {
    if (rule.selector === '.tabs') rule.walkDecls(declaration => { declarations[declaration.prop] = declaration.value })
  })
  assert.equal(declarations.height, '38px')
  assert.equal(declarations['min-height'], '38px')
})
