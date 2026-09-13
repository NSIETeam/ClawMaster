/** Actual Better Sidebar EditorHost and CodeMirror across the production DSH tab renderer. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as JSX from 'react/jsx-runtime'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'
import { apply, inject } from '../../../packages/client/ui-sidebar-right/src/client/index.ts'

const repository = resolve(process.cwd())
const core = resolve(process.env.DSH_DESKTOP_SMOKE_ROOT ?? join(repository, 'apps/desktop-tauri/bundled/harness'))
const resolver = createRequire(join(core, 'apps/cli/package.json'))
const packageRoot = process.env.DSH_SIDEBAR_TEST_PACKAGE_ROOT
  ? resolve(process.env.DSH_SIDEBAR_TEST_PACKAGE_ROOT)
  : dirname(resolver.resolve('dsh-better-sidebar/package.json'))
const SESSION = 'editor-retention'
const CWD = resolve(repository, 'synthetic-editor-retention')
const FILE = join(CWD, 'desktop-check-clean.csv')
const ORIGINAL = 'sku,name,stock\nA1,Original record,3\n'
const DRAFT = 'sku,name,stock\nDRAFT-20260913,Native editor retention,20\n'
const runtimes = []
let restoreGeometry
let restoreLoader

beforeEach(() => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  const originals = [
    [Element.prototype, 'getAnimations', () => []],
    [Range.prototype, 'getClientRects', () => []],
    [Range.prototype, 'getBoundingClientRect', () => new DOMRect()],
  ].map(([target, key, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, writable: true, value })
    return [target, key, descriptor]
  })
  restoreGeometry = () => {
    for (const [target, key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(target, key, descriptor)
      else Reflect.deleteProperty(target, key)
    }
  }
  const loader = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__')
  restoreLoader = () => {
    if (loader) Object.defineProperty(window, '__ModuleLoader__', loader)
    else Reflect.deleteProperty(window, '__ModuleLoader__')
  }
  vi.stubGlobal('__dshChunks__', {})
})

afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    restoreGeometry()
    restoreLoader()
  }
})

/** Read private factory exports in memory; the installed artifact is never edited. */
async function factory() {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  expect(manifest.name).toBe('dsh-better-sidebar')
  expect(manifest.version).toBe('0.19.1')
  const source = await readFile(join(packageRoot, 'lib/client.js'), 'utf8')
  const editorSource = await readFile(join(packageRoot, 'lib/client-editor.js'), 'utf8')
  const provenance = JSON.parse(await readFile(join(repository, 'apps/desktop-tauri/patches/dsh-better-sidebar@0.19.1.provenance.json'), 'utf8'))
  expect(createHash('sha256').update(source).digest('hex')).toBe(provenance.patchedSha256['lib/client.js'])
  const external = id => {
    const modules = { react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient,
      'react/jsx-runtime': JSX, '@deepseek-ai/dsh-client-ui-primitives': primitives }
    if (!(id in modules)) throw new Error(`Unexpected client external: ${id}`)
    return modules[id]
  }
  let entry
  window.__ModuleLoader__ = { load: value => { entry = value.factory } }
  const end = 'return module.exports;'
  expect(source.split(end)).toHaveLength(2)
  vm.runInThisContext(source.replace(end, 'return { ...module.exports, createNativeTabRecords, createNativeSurface, registerNativeSurface, createBetterSidebarService, createSidebarStore, registerBuiltins, testLoaders, api };'))
  const lib = entry(external)
  expect(editorSource.split(end)).toHaveLength(2)
  vm.runInThisContext(editorSource.replace(end, 'return { ...module.exports, EditorView, api };'))
  const editor = globalThis.__dshChunks__.editor(external)
  lib.testLoaders.set('editor', async () => editor)
  return { lib, editor }
}

async function fixture() {
  const { lib, editor } = await factory()
  const disk = new Map([[FILE, ORIGINAL]])
  const read = vi.fn(async (scope, path) => {
    const absolute = resolve(scope.cwd, path)
    if (!disk.has(absolute)) throw new Error(`Missing synthetic file ${absolute}`)
    return { kind: 'text', content: disk.get(absolute), truncated: false }
  })
  const write = vi.fn(async (scope, path, content) => { disk.set(resolve(scope.cwd, path), content); return { ok: true } })
  lib.api.fsRead = read
  lib.api.fsTree = async (_scope, path) => ({ path, entries: [], truncated: false })
  editor.api.fsWrite = write
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const frame = { openRightbar: vi.fn(), closeRightbar: vi.fn() }
  runtime.ctx.provide('layout', frame)
  runtime.ctx.provide('resources', { pin: vi.fn() })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({
    rightbar: { kind: 'single', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  })
  await runtime.sessions.add({ id: SESSION, summary: { cwd: CWD, blank: true } })
  await runtime.mount({ inject: [...inject], apply })
  const store = lib.createSidebarStore()
  store.setSession(SESSION)
  const service = lib.createBetterSidebarService(store)
  const records = lib.createNativeTabRecords()
  const surface = lib.createNativeSurface(runtime.ctx, records)
  service.setSurface(surface)
  await runtime.mount({
    inject: ['sidebarRightTabs', 'slots'],
    apply(ctx) {
      ctx.provide('betterSidebar', service)
      const builtins = lib.registerBuiltins(ctx, service)
      const registrations = lib.registerNativeSurface({ ctx, store, service, records })
      ctx.effect(() => () => { registrations(); builtins(); surface.dispose(); lib.testLoaders.clear() })
    },
  })
  const view = runtime.renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true })
  const controller = runtime.ctx.sidebarRight
  const scope = { sessionId: SESSION, cwd: CWD }
  await waitFor(() => expect(runtime.ctx.sidebarRightTabs.get('files')).toBeDefined())
  await act(async () => { service.openTab({ type: 'editor' }, scope) })
  const files = controller.active()
  await act(async () => { service.openTab({ type: 'editor', path: FILE, title: 'desktop-check-clean.csv' }, scope) })
  const csv = controller.active()
  await waitFor(() => expect(view.container.querySelector('.cm-editor')).not.toBeNull())
  const cm = editor.EditorView.findFromDOM(view.container.querySelector('.cm-editor'))
  return { runtime, service, controller, records, scope, view, files, csv, cm, disk, read, write, frame, editor, store }
}

it.each(['tab switch', 'global panels and document shortcut'])('retains the actual CSV editor through %s and saves only on request', async route => {
  const f = await fixture()
  expect(f.files.id).not.toBe(f.csv.id)
  const signal = f.records.get(f.csv.id, SESSION).signal
  const destroyed = vi.spyOn(f.cm, 'destroy')
  await act(async () => {
    f.cm.dispatch({ changes: { from: 0, to: f.cm.state.doc.length, insert: DRAFT } })
    f.cm.focus()
  })
  expect(f.cm.state.doc.toString()).toBe(DRAFT)
  expect(f.disk.get(FILE)).toBe(ORIGINAL)
  vi.spyOn(f.cm, 'coordsAtPos').mockReturnValue({ top: 100, bottom: 120, left: 100, right: 150 })
  act(() => { f.cm.dispatch({ selection: { anchor: 0, head: 3 } }) })
  expect(screen.getByRole('button', { name: 'Add to conversation' })).toBeDefined()
  if (route === 'global panels and document shortcut') {
    act(() => { f.runtime.panelInfo.set({ activePanelId: 'clawmaster' }) })
    expect(f.view.container.querySelector('[data-sidebar-right-panel]').hidden).toBe(true)
    act(() => { f.runtime.panelInfo.set({ activePanelId: 'clawmaster' }) })
    act(() => { f.runtime.panelInfo.set({ activePanelId: null }) })
    await act(async () => { f.service.openTab({ type: 'editor' }, f.scope) })
  } else {
    fireEvent.click(f.view.container.querySelector(`[data-dockkit-tab="${f.files.id}"]`))
  }
  expect(f.controller.active().id).toBe(f.files.id)
  expect(destroyed).not.toHaveBeenCalled()
  expect(f.cm.dom.isConnected).toBe(true)
  expect(document.activeElement).not.toBe(f.cm.contentDOM)
  expect(f.cm.dom.closest('[data-dockkit-tab-body]').inert).toBe(true)
  expect(f.cm.dom.closest('[hidden]')).not.toBeNull()
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Add to conversation' })).toBeNull())
  fireEvent.keyDown(document.activeElement, { key: 's', code: 'KeyS', metaKey: true })
  expect(f.write).not.toHaveBeenCalled()
  fireEvent.click(f.view.container.querySelector(`[data-dockkit-tab="${f.csv.id}"]`))
  expect(f.controller.active().id).toBe(f.csv.id)
  expect(f.editor.EditorView.findFromDOM(f.view.container.querySelector('.cm-editor'))).toBe(f.cm)
  expect(f.cm.state.doc.toString()).toBe(DRAFT)
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(f.write).not.toHaveBeenCalled()
  await act(async () => {
    f.cm.focus()
    fireEvent.keyDown(f.cm.contentDOM, { key: 's', code: 'KeyS', metaKey: true })
  })
  await waitFor(() => expect(f.write).toHaveBeenCalledTimes(1))
  expect(f.disk.get(FILE)).toBe(DRAFT)
  await act(async () => { f.controller.close(f.csv.id) })
  expect(destroyed).toHaveBeenCalledTimes(1)
  expect(signal.aborted).toBe(true)
  expect(f.records.get(f.csv.id, SESSION)).toBeUndefined()
})

it.each(['en-US', 'zh-CN'])('the actual native close button keeps a cancelled draft and saves before a clean close (%s)', async language => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language)
  const expected = JSON.parse(await readFile(join(repository, 'frontends/office/tests/expected/dirty-leave.json'), 'utf8'))[language]
  const f = await fixture()
  const destroyed = vi.spyOn(f.cm, 'destroy')
  await act(async () => { f.cm.dispatch({ changes: { from: 0, to: f.cm.state.doc.length, insert: DRAFT } }) })
  const close = () => fireEvent.click(f.view.container.querySelector(`[data-dockkit-tab="${f.csv.id}"] button`))
  await act(async () => { close() })
  expect(screen.getByRole('dialog').textContent).toContain(expected.description)
  expect(destroyed).not.toHaveBeenCalled(); expect(f.disk.get(FILE)).toBe(ORIGINAL)
  await act(async () => { f.controller.close(f.csv.id) })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: expected.cancel, exact: true }).at(-1)) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.cm.state.doc.toString()).toBe(DRAFT); expect(destroyed).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: expected.save, exact: true })) })
  await waitFor(() => expect(f.disk.get(FILE)).toBe(DRAFT))
  await act(async () => { close() })
  expect(screen.queryByRole('dialog')).toBeNull(); expect(destroyed).toHaveBeenCalledTimes(1)
})

it('refresh and in-place file navigation keep the actual draft until discard is explicit', async () => {
  const f = await fixture()
  await act(async () => { f.cm.dispatch({ changes: { from: 0, to: f.cm.state.doc.length, insert: DRAFT } }) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true })) })
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Cancel', exact: true }).at(-1)) })
  expect(f.cm.state.doc.toString()).toBe(DRAFT); expect(f.read).toHaveBeenCalledTimes(1)
  await act(async () => { f.store.setPrefs({ ...f.store.getSnapshot().prefs, editorExplorer: true }) })
  const next = join(CWD, 'second.csv'); f.disk.set(next, 'second file')
  const input = f.cm.dom.closest('[data-dsh-native-tab-host]').querySelector('input')
  await act(async () => { fireEvent.change(input, { target: { value: next } }); fireEvent.keyDown(input, { key: 'Enter' }) })
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Cancel', exact: true }).at(-1)) })
  expect(f.cm.state.doc.toString()).toBe(DRAFT); expect(f.read).toHaveBeenCalledTimes(1)
  await act(async () => { f.controller.close(f.csv.id) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard changes', exact: true })) })
  expect(f.disk.get(FILE)).toBe(ORIGINAL)
  expect(f.records.get(f.csv.id, SESSION)).toBeUndefined()
})
