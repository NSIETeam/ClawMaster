/** Native browser acceptance against the pinned client factory and its original-package control. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const dependencies = createRequire(join(repository, 'apps/web/package.json'))
const core = resolve(process.env.DSH_DESKTOP_SMOKE_ROOT ?? join(repository, 'apps/desktop-tauri/bundled/harness'))
const resolver = createRequire(join(core, 'apps/cli/package.json'))
const packageRoot = process.env.DSH_SIDEBAR_TEST_PACKAGE_ROOT
  ? resolve(process.env.DSH_SIDEBAR_TEST_PACKAGE_ROOT)
  : dirname(resolver.resolve('dsh-better-sidebar/package.json'))
const patchPath = fileURLToPath(new URL('../patches/dsh-better-sidebar@0.19.1.patch', import.meta.url))
const provenance = JSON.parse(await readFile(fileURLToPath(new URL('../patches/dsh-better-sidebar@0.19.1.provenance.json', import.meta.url)), 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const isClientFile = file => file.startsWith('src/client/') || file.startsWith('lib/types/client/')
  || /^lib\/client(?:-[^/]+)?\.js$/.test(file)

/** Expose private factory functions without replacing their implementation or JSX. */
async function loadFactory(root, require) {
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  const end = 'return module.exports;'
  assert.equal(source.split(end).length, 2)
  let factory
  window.__ModuleLoader__ = { load: entry => { factory = entry.factory } }
  vm.runInThisContext(source.replace(end, 'return { ...module.exports, createNativeTabRecords, createNativeSurface, NativeTabBody, NativeTabTitle, BrowserView, createBetterSidebarService, createSidebarStore, api };'), { filename: 'dsh-better-sidebar/lib/client.js' })
  const exports = factory(id => id === '@deepseek-ai/dsh-client-ui-primitives'
    ? new Proxy({}, { get: () => () => null })
    : require(id))
  // The fixture owns the sole external browser probe. Iframes are not loaded by JSDOM.
  exports.api.browserProbe = async () => ({})
  return exports
}

test('native sidebar retains browser navigation and isolates Session-owned records', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'clawmaster-sidebar-regression-'))
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3 }))
  const original = join(temporary, 'original')
  const patched = join(temporary, 'patched')
  await mkdir(original)
  await mkdir(patched)
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-better-sidebar')
  assert.equal(manifest.version, '0.19.1')
  assert.equal(sha(await readFile(patchPath)), provenance.patchSha256)
  const installedHash = sha(await readFile(join(packageRoot, 'lib/client.js')))
  const isPatched = installedHash === provenance.patchedSha256['lib/client.js']
  assert.ok(isPatched || installedHash === provenance.upstreamSha256['lib/client.js'], 'unknown plugin artifact')
  // Office Host edits have separate save coverage and input provenance.
  const clientFiles = Object.keys(provenance.patchedSha256).filter(isClientFile)
  assert.deepEqual(clientFiles.toSorted(), Object.keys(provenance.upstreamSha256).filter(isClientFile).toSorted())
  for (const file of clientFiles) {
    assert.equal(sha(await readFile(join(packageRoot, file))), (isPatched ? provenance.patchedSha256 : provenance.upstreamSha256)[file], file)
    for (const destination of [original, patched]) {
      await mkdir(dirname(join(destination, file)), { recursive: true })
      await cp(join(packageRoot, file), join(destination, file))
    }
  }
  const changed = spawnSync('git', ['apply', ...(isPatched ? ['--reverse'] : []),
    ...clientFiles.map(file => `--include=${file}`), patchPath], {
    cwd: isPatched ? original : patched, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(changed.error, undefined)
  assert.equal(changed.signal, null)
  assert.equal(changed.status, 0, changed.stderr)
  for (const file of clientFiles) {
    assert.equal(sha(await readFile(join(original, file))), provenance.upstreamSha256[file], `original ${file}`)
    assert.equal(sha(await readFile(join(patched, file))), provenance.patchedSha256[file], `patched ${file}`)
  }

  const { JSDOM } = dependencies('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://clawmaster.invalid/', pretendToBeVisual: true })
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'localStorage', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']
  const before = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => {
    dom.window.close()
    for (const [key, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  for (const key of globals) Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key],
  })
  const React = dependencies('react')
  const { createRoot } = dependencies('react-dom/client')
  const { act } = React

  const fixture = async (owner, directory) => {
    const lib = await loadFactory(directory, dependencies)
    const rows = { a: { cwd: '/synthetic-a' }, b: { cwd: '/synthetic-b' } }
    let current = 'a'
    const closed = []
    const subscribers = new Set()
    const ctx = {
      sessions: { list: { getSnapshot: () => ({ current, byId: rows }), subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback) } } },
      sidebarRight: { close: id => closed.push([current, id]), closeIn: (id, tabId) => closed.push([id, tabId]) },
      get(name) { return this[name] },
    }
    const store = lib.createSidebarStore()
    store.setSession('a')
    const service = lib.createBetterSidebarService(store)
    ctx.betterSidebar = service
    const records = lib.createNativeTabRecords()
    const surface = lib.createNativeSurface(ctx, records)
    service.setSurface(surface)
    service.registerTab({ id: 'browser', title: 'Browser', component: lib.BrowserView })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const controllers = []
    owner.after(async () => {
      await act(async () => root.unmount())
      surface.dispose()
      for (const controller of controllers) controller.abort()
      host.remove()
      assert.equal(subscribers.size, 0)
    })
    const tab = (id = 'tab2', params, kind = 'browser') => {
      const controller = new AbortController()
      controllers.push(controller)
      return { controller, info: { tab: { id, kind, title: kind, contentId: kind, visible: true, navigation: { address: kind, params, revision: 1 }, signal: controller.signal, actions: { beforeClose: () => () => {} } } } }
    }
    const mount = async (value, sessionId = 'a', descriptorId = 'browser') => {
      await act(async () => {
        current = sessionId
        store.setSession(sessionId)
        for (const listener of subscribers) listener()
        root.render(value === null ? null : React.createElement(lib.NativeTabBody, {
          key: sessionId, ctx, store, service, records, descriptorId, sessionId, useTabInfo: () => value.info,
        }))
      })
    }
    const navigate = async value => {
      const input = host.querySelector('input')
      assert.ok(input, host.textContent)
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
        input.dispatchEvent(new window.Event('change', { bubbles: true }))
      })
      await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
      assert.equal(host.querySelector('iframe')?.getAttribute('src'), new URL(value).href)
    }
    const url = () => host.querySelector('input')?.value
    const history = async direction => {
      const button = host.querySelector(`[aria-label="${direction}"]`)
      assert.ok(button && !button.disabled, `available ${direction}`)
      await act(async () => button.click())
    }
    return { lib, host, ctx, service, records, surface, closed, tab, mount, navigate, url, history }
  }

  await t.test('original package loses a visited address on a global-panel round trip', async child => {
    const f = await fixture(child, original)
    const tab = f.tab()
    await f.mount(tab)
    await f.navigate('https://example.com/first')
    await f.mount(null)
    await f.mount(tab)
    assert.equal(f.url(), '')
    assert.equal(f.host.querySelector('iframe'), null)
  })

  await t.test('same native tab restores address and back/forward state after temporary unmount', async child => {
    const f = await fixture(child, patched)
    const tab = f.tab()
    await f.mount(tab)
    await f.navigate('https://example.com/first')
    await f.navigate('https://example.com/second')
    await f.history('Back')
    await f.mount(null)
    await f.mount(tab)
    assert.equal(f.url(), 'https://example.com/first')
    await f.history('Forward')
    assert.equal(f.url(), 'https://example.com/second')
    assert.equal(tab.controller.signal.aborted, false)
  })

  await t.test('same native id in two Sessions preserves independent URLs and targeted updates', async child => {
    const f = await fixture(child, patched)
    const a = f.tab()
    const b = f.tab()
    await f.mount(a, 'a')
    await f.navigate('https://example.com/a')
    const aId = f.records.get('tab2', 'a').tab.id
    await f.mount(b, 'b')
    assert.equal(f.url(), '')
    await f.navigate('https://example.com/b')
    const bId = f.records.get('tab2', 'b').tab.id
    assert.notEqual(aId, bId)
    f.service.updateTab(aId, { title: 'A retained' })
    assert.equal(f.records.get('tab2', 'b').tab.title, 'example.com')
    await f.mount(a, 'a')
    assert.equal(f.url(), 'https://example.com/a')
    await f.mount(b, 'b')
    assert.equal(f.url(), 'https://example.com/b')
  })

  await t.test('actual close abort releases only its record, while explicit close uses the native id', async child => {
    const f = await fixture(child, patched)
    const a = f.tab()
    const b = f.tab()
    await f.mount(a, 'a')
    await f.navigate('https://example.com/a')
    await f.mount(b, 'b')
    await f.navigate('https://example.com/b')
    await act(async () => a.controller.abort())
    assert.equal(f.records.get('tab2', 'a'), undefined)
    const bId = f.records.get('tab2', 'b').tab.id
    await f.mount(null, 'b')
    f.service.closeTab(bId, { sessionId: 'b' })
    assert.deepEqual(f.closed, [['b', 'tab2']])
    assert.equal(f.records.get('tab2', 'b'), undefined)
  })

  await t.test('URL seeds and later native navigation replace the address without stale history', async child => {
    const f = await fixture(child, patched)
    const tab = f.tab('tab2', { url: 'https://example.com/seed' })
    await f.mount(tab)
    assert.equal(f.url(), 'https://example.com/seed')
    await f.navigate('https://example.com/manual')
    await f.mount(null)
    await f.mount(tab)
    assert.equal(f.url(), 'https://example.com/manual')
    tab.info.tab.navigation = { address: 'browser', params: { url: 'https://example.com/replaced' }, revision: 2 }
    await f.mount(tab)
    assert.equal(f.url(), 'https://example.com/replaced')
    assert.equal(f.host.querySelector('[aria-label="Back"]').disabled, true)
  })

  await t.test('editor path and tree metadata survive remount until an explicit navigation', async child => {
    const f = await fixture(child, patched)
    let props
    f.service.registerTab({ id: 'editor', title: 'Editor', component: value => { props = value; return React.createElement('output', null, value.tab.path) } })
    const tab = f.tab('tab2', { path: '/synthetic-a/first.md' }, 'editor')
    await f.mount(tab, 'a', 'editor')
    await act(async () => f.service.updateTab(props.tab.id, {
      path: '/synthetic-a/second.md', title: 'second.md', meta: { treeOpen: true, treeWidth: 270 },
    }))
    await f.mount(null)
    await f.mount(tab, 'a', 'editor')
    assert.equal(props.tab.path, '/synthetic-a/second.md')
    assert.deepEqual(props.tab.meta, { treeOpen: true, treeWidth: 270 })
    tab.info.tab.navigation = { address: 'editor', params: { path: '/synthetic-a/third.md' }, revision: 2 }
    await f.mount(tab, 'a', 'editor')
    assert.equal(props.tab.path, '/synthetic-a/third.md')
    assert.deepEqual(props.tab.meta, { treeOpen: true, treeWidth: 270 })
  })
})
