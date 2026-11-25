import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import postcss from 'postcss'
import { NConfigProvider } from 'naive-ui'

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  plugins: [vue()],
  server: { middlewareMode: true },
  appType: 'custom',
})
test.after(() => server.close())

async function load(name) {
  return (await server.ssrLoadModule(`/src/components/${name}.vue`)).default
}

async function render(name, props = {}, slots = {}, provides = {}, withNaiveProvider = false) {
  const component = await load(name)
  const app = createSSRApp(defineComponent({
    render: () => withNaiveProvider
      ? h(NConfigProvider, null, { default: () => h(component, props, slots) })
      : h(component, props, slots),
  }))
  for (const [key, value] of Object.entries(provides)) app.provide(key, value)
  return renderToString(app)
}

async function renderIconButton(props) {
  return render('IconButton', props, {}, {}, true)
}

async function styleDeclarations(selector) {
  const { default: css } = await server.ssrLoadModule('/src/style.css?inline')
  const declarations = {}
  postcss.parse(css).walkRules(rule => {
    if (rule.selector === selector) {
      rule.walkDecls(declaration => { declarations[declaration.prop] = declaration.value })
    }
  })
  return declarations
}

function ProbeIcon(name) {
  return defineComponent({
    render: () => h('svg', { 'data-probe-icon': name, 'aria-hidden': 'true' }),
  })
}

test('icon buttons use Naive UI button semantics and always expose an accessible name', async () => {
  const html = await renderIconButton({ label: '刷新键', icon: 'span' })
  assert.match(html, /<button\b/)
  assert.match(html, /class="[^"]*\bn-button\b/)
  assert.match(html, /type="button"/)
  assert.match(html, /aria-label="刷新键"/)
  assert.match(html, /title="刷新键"/)
  assert.match(html, /data-size="small"/)
})

test('icon buttons prefer an explicit title and support medium size', async () => {
  const html = await renderIconButton({ label: '关闭', title: '关闭面板', icon: 'span', size: 'medium' })
  assert.match(html, /aria-label="关闭"/)
  assert.match(html, /title="关闭面板"/)
  assert.match(html, /data-size="medium"/)
})

test('icon buttons expose danger, disabled, and Naive UI loading states', async () => {
  const disabled = await renderIconButton({ label: '删除', icon: 'span', danger: true, disabled: true })
  assert.match(disabled, /data-danger="true"/)
  assert.match(disabled, /\sdisabled(?:\s|>)/)

  const loading = await renderIconButton({ label: '保存', icon: 'span', loading: true })
  assert.match(loading, /data-loading="true"/)
  assert.match(loading, /aria-busy="true"/)
  assert.match(loading, /\sdisabled(?:\s|>)/)
  assert.match(loading, /class="[^"]*\bn-button--loading\b/)
  assert.match(loading, /class="[^"]*\bn-base-loading\b/)
})

test('shared styles retain compact control sizes and panel title metrics', async () => {
  const compact = await styleDeclarations('.shared-icon-button')
  assert.equal(compact.width, '28px')
  assert.equal(compact.height, '28px')
  assert.equal((await styleDeclarations('.shared-icon-button[data-size="medium"]')).width, '32px')
  assert.equal((await styleDeclarations('.shared-icon-button[data-size="medium"]')).height, '32px')
  assert.equal((await styleDeclarations('.shared-panel-header__title'))['font-size'], '19px')
  assert.equal((await styleDeclarations('.shared-panel-header__icon')).width, '18px')
  assert.equal((await styleDeclarations('.shared-panel-header__icon')).height, '18px')
})

test('panel headers render eyebrow, title, title icon, and actions slots', async () => {
  const html = await render('PanelHeader', { icon: ProbeIcon('title') }, {
    eyebrow: () => '服务器',
    title: () => '连接详情',
    actions: () => h('button', { type: 'button' }, '刷新'),
  })
  assert.match(html, /<header\b/)
  assert.match(html, /data-probe-icon="title"/)
  assert.match(html, />服务器</)
  assert.match(html, />连接详情</)
  assert.match(html, />刷新</)
  assert.match(html, /data-slot="eyebrow"/)
  assert.match(html, /data-slot="title"/)
  assert.match(html, /data-slot="actions"/)
})

test('panel headers omit optional regions when no slot is supplied', async () => {
  const html = await render('PanelHeader', {}, { title: () => '键' })
  assert.doesNotMatch(html, /data-slot="eyebrow"/)
  assert.doesNotMatch(html, /data-slot="actions"/)
  assert.doesNotMatch(html, /data-probe-icon/)
})

test('empty states render content, optional icon, and actions without a provider', async () => {
  const html = await render('EmptyState', { icon: ProbeIcon('empty') }, {
    default: () => '没有匹配的键',
    actions: () => h('button', { type: 'button' }, '清除筛选'),
  })
  assert.match(html, /data-compact="false"/)
  assert.match(html, /data-probe-icon="empty"/)
  assert.match(html, />没有匹配的键</)
  assert.match(html, />清除筛选</)
})

test('empty states can use the compact bordered presentation', async () => {
  const html = await render('EmptyState', { compact: true }, { default: () => '暂无连接' })
  assert.match(html, /data-compact="true"/)
  assert.match(html, />暂无连接</)
  assert.doesNotMatch(html, /data-slot="actions"/)
})

test('status notices use alert for errors and status for every other tone', async () => {
  for (const tone of ['info', 'success', 'warning', 'error', 'stale']) {
    const html = await render('StatusNotice', { tone, title: '状态', text: '说明' })
    assert.match(html, new RegExp(`data-tone="${tone}"`))
    assert.match(html, tone === 'error' ? /role="alert"/ : /role="status"/)
    assert.match(html, />状态</)
    assert.match(html, /说明/)
  }
})

test('status notices only show a retry control when requested', async () => {
  const plain = await render('StatusNotice', { tone: 'info', text: '正在连接' })
  assert.doesNotMatch(plain, /<button\b/)

  const retry = await render('StatusNotice', { tone: 'error', title: '连接失败', text: '无法访问服务器', retry: true })
  assert.match(retry, /<button\b/)
  assert.match(retry, /type="button"/)
  assert.match(retry, />重试</)
})

test('stale notices always explain cached data and offer retry', async () => {
  const html = await render('StatusNotice', { tone: 'stale', title: '刷新失败' })
  assert.match(html, /缓存/)
  assert.match(html, />重试</)
  assert.match(html, /role="status"/)
})

test('stale notices retain cached wording when title and text are overridden', async () => {
  const html = await render('StatusNotice', {
    tone: 'stale', title: '刷新失败', text: '最后成功时间：10:30',
  })
  assert.match(html, />刷新失败</)
  assert.match(html, /最后成功时间：10:30/)
  assert.match(html, /缓存/)
  assert.match(html, /过期/)
  assert.match(html, />重试</)
})

test('status notices use optional workspace translations without requiring a provider', async () => {
  const html = await render('StatusNotice', { tone: 'stale' }, {}, { tr: (zh, en) => en })
  assert.match(html, />Data may be stale</)
  assert.match(html, /Showing cached data/)
  assert.match(html, />Retry</)
})
