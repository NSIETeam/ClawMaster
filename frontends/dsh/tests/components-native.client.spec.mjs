/** Compiled enterprise components in Better Sidebar's settings and DSH's native rightbar. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JSX from 'react/jsx-runtime';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime';
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { LayoutController } from '../../../packages/client/ui-layout/src/client/service.ts';
import { UiWorkspaceService } from '../../../packages/client/ui-workspace/src/client/navigation.ts';
import { apply, inject } from '../../../packages/client/ui-sidebar-right/src/client/index.ts';

const repository = resolve(process.cwd());
const resolver = createRequire(join(process.env.DSH_DESKTOP_SMOKE_ROOT ?? join(repository, 'apps/desktop-tauri/bundled/harness'), 'apps/cli/package.json'));
const sidebarRoot = process.env.DSH_SIDEBAR_TEST_PACKAGE_ROOT ?? dirname(resolver.resolve('dsh-better-sidebar/package.json'));
const cleanups = [];
let animations;
let loader;

beforeEach(() => {
  animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  loader = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
});
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
    else Reflect.deleteProperty(Element.prototype, 'getAnimations');
    if (loader) Object.defineProperty(window, '__ModuleLoader__', loader);
    else Reflect.deleteProperty(window, '__ModuleLoader__');
  }
});

/** Expose existing factory-local helpers only in memory; production artifacts stay unchanged. */
async function factories() {
  const manifest = JSON.parse(await readFile(join(sidebarRoot, 'package.json'), 'utf8'));
  expect([manifest.name, manifest.version]).toEqual(['dsh-better-sidebar', '0.19.1']);
  const external = id => {
    const modules = { react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient,
      'react/jsx-runtime': JSX, '@deepseek-ai/dsh-client-ui-primitives': primitives };
    if (!(id in modules)) throw new Error(`Unexpected client external: ${id}`);
    return modules[id];
  };
  let entry;
  window.__ModuleLoader__ = { load: value => { entry = value.factory; } };
  const source = await readFile(join(sidebarRoot, 'lib/client.js'), 'utf8');
  const end = 'return module.exports;';
  expect(source.split(end)).toHaveLength(2);
  vm.runInThisContext(source.replace(end, 'return { ...module.exports, createNativeTabRecords, createNativeSurface, registerNativeSurface, createBetterSidebarService, createSidebarStore, SideCardSection, api };'));
  const sidebar = entry(external);
  vm.runInThisContext(await readFile(join(repository, 'frontends/dsh/dist/client.js'), 'utf8'));
  return { sidebar, frontend: entry(external) };
}

async function fixture(existing = true) {
  const { sidebar, frontend } = await factories();
  const request = vi.fn(async (path, init) => {
    expect(init.credentials).toBe('same-origin');
    if (path === '/api/clawmaster/workspace') return Response.json({ workspaceId: 'managed', path: '/synthetic/desk' });
    if (path === '/api/clawmaster/enterprise') return Response.json({ revision: 0, contacts: [], inventory: [], orders: [], audit: [] });
    throw new Error(`Unexpected enterprise request: ${path}`);
  });
  vi.stubGlobal('fetch', request);
  const runtime = await SlotTestRuntime.create();
  cleanups.push(() => runtime.dispose());
  const layout = new LayoutController({
    selectPanel: activePanelId => runtime.panelInfo.set({ activePanelId }), openRightbar() {}, closeRightbar() {},
  }, () => true);
  runtime.ctx.provide('layout', layout);
  runtime.ctx.effect(() => () => layout.dispose());
  runtime.ctx.provide('resources', { pin() {} });
  const locale = new LocaleRuntime(runtime.ctx);
  runtime.ctx.provide('locale', locale);
  runtime.slots.installLocale(locale);
  await runtime.declare({ rightbar: { kind: 'single', scope: 'root' }, 'conversation.session.header.corner': { kind: 'single', scope: 'session' } });
  if (existing) await runtime.sessions.add({ id: 'existing', summary: { cwd: '/synthetic/existing', blank: true } });
  runtime.sessions.stubCreate(async () => runtime.sessions.add({ id: 'created', summary: { cwd: '/synthetic/desk', blank: true } }, { current: false }));
  await runtime.mount({ inject: [...inject], apply });
  const store = sidebar.createSidebarStore();
  if (existing) store.setSession('existing');
  store.setPrefs({ ...store.getPrefs(), tabsEnabled: { browser: false } });
  const service = sidebar.createBetterSidebarService(store);
  const records = sidebar.createNativeTabRecords();
  const surface = sidebar.createNativeSurface(runtime.ctx, records);
  service.setSurface(surface);
  let persisted = store.getPrefs();
  sidebar.api.settingsGet = vi.fn(async () => ({ value: persisted, revision: 1 }));
  sidebar.api.settingsUpdate = vi.fn(async patch => {
    persisted = { ...persisted, ...patch };
    return { value: persisted, revision: 2 };
  });
  await runtime.mount({
    inject: ['sidebarRightTabs', 'slots'],
    apply(ctx) {
      ctx.provide('betterSidebar', service);
      const unregister = sidebar.registerNativeSurface({ ctx, store, service, records });
      ctx.effect(() => () => { unregister(); surface.dispose(); });
    },
  });
  const slots = [];
  const pluginCleanups = [];
  cleanups.push(() => { for (const cleanup of pluginCleanups.reverse()) cleanup(); });
  const uiWorkspace = new UiWorkspaceService(runtime.ctx, {}, runtime.workspaces, runtime.sessions);
  frontend.apply({
    slots: { inject(_name, setup) { pluginCleanups.push(setup()); }, register(options, component) { slots.push({ options, component }); return () => {}; } },
    theme: { overrideTokens: () => () => {} },
    sessions: runtime.sessions, workspaces: runtime.workspaces, layout, uiWorkspace, betterSidebar: service,
    locale: { getSnapshot: () => localeSnapshot, subscribe: () => () => {} },
    settingsScope: { bind() { return { getSnapshot: () => ({ mode: 'host', status: 'ready', value: { acknowledgedVersion: 0 } }), subscribe: () => () => {} }; } },
    connection: { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } },
    effect(setup) { pluginCleanups.push(setup()); },
  });
  const view = runtime.renderSlot('rightbar', { width: 360, viewportWidth: 1440, canShow: true });
  act(() => layout.selectPanel('settings'));
  const settings = render(React.createElement(sidebar.SideCardSection, { store, service }));
  cleanups.push(() => settings.unmount());
  await waitFor(() => expect(sidebar.api.settingsGet).toHaveBeenCalledTimes(1));
  return { runtime, layout, service, store, records, view, settings, request, slots, sidebar, controller: runtime.ctx.sidebarRight };
}
const localeSnapshot = { active: 'zh' };

async function openFromSettings(f, title) {
  fireEvent.click(f.settings.getByRole('button', { name: new RegExp(`${title} (Feature settings|功能设置)`) }));
  fireEvent.click(screen.getByRole('button', { name: '在右侧打开' }));
  await waitFor(() => expect(f.runtime.panelInfo.getSnapshot().activePanelId).toBeNull());
  await waitFor(() => expect(screen.queryByRole('button', { name: '在右侧打开' })).toBeNull());
}

it.each([false, true])('opens CRM and ERP from the real component settings without default Workspace selection (existing=%s)', async existing => {
  const f = await fixture(existing);
  expect(f.request).not.toHaveBeenCalled();
  expect(f.runtime.sessions.calls.filter(call => call.method === 'create')).toHaveLength(0);
  expect(f.slots.filter(slot => slot.options.name === 'sidebar.panellist').map(slot => slot.options.id)).toEqual(['clawmaster']);
  expect(f.service.getTabs().map(tab => tab.id)).toEqual(['clawmaster:crm', 'clawmaster:erp']);
  const crmToggle = f.settings.getByRole('button', { name: 'CRM 客户 clawmaster:crm' });
  expect(crmToggle.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(crmToggle);
  await waitFor(() => expect(f.service.isTabEnabled('clawmaster:crm')).toBe(false));
  expect(f.store.getPrefs().tabsEnabled.browser).toBe(false);
  expect(f.settings.queryByRole('button', { name: /CRM 客户 (Feature settings|功能设置)/ })).toBeNull();
  expect(f.request).not.toHaveBeenCalled();
  fireEvent.click(crmToggle);
  await waitFor(() => expect(f.service.isTabEnabled('clawmaster:crm')).toBe(true));
  await openFromSettings(f, 'CRM 客户');
  const crm = f.controller.active();
  expect(crm.kind).toBe('clawmaster:crm');
  await waitFor(() => expect(within(f.view.container).getByRole('button', { name: '新建客户' })).toBeDefined());
  const crmBody = f.view.container.querySelector('.cm-enterprise');
  fireEvent.click(within(f.view.container).getByRole('button', { name: '新建客户' }));
  const name = within(f.view.container).getByRole('textbox', { name: '姓名', exact: true });
  fireEvent.change(name, { target: { value: 'Synthetic unsaved contact' } });
  act(() => f.layout.selectPanel('settings'));
  await openFromSettings(f, 'ERP 库存与订单');
  const erp = f.controller.active();
  expect(erp.kind).toBe('clawmaster:erp');
  expect(erp.id).not.toBe(crm.id);
  expect(crmBody.closest('[hidden]')).not.toBeNull();
  act(() => f.layout.selectPanel('settings'));
  await openFromSettings(f, 'CRM 客户');
  expect(f.controller.active().id).toBe(crm.id);
  expect(f.view.container.querySelectorAll(`[data-dockkit-tab="${crm.id}"]`)).toHaveLength(1);
  expect(name.isConnected).toBe(true);
  expect(name.value).toBe('Synthetic unsaved contact');
  const closed = f.records.get(crm.id, existing ? 'existing' : 'created').signal;
  act(() => f.controller.close(crm.id));
  expect(closed.aborted).toBe(true);
  expect(name.isConnected).toBe(false);
  act(() => f.layout.selectPanel('settings'));
  await openFromSettings(f, 'CRM 客户');
  await waitFor(() => expect(within(f.view.container).getByRole('button', { name: '新建客户' })).toBeDefined());
  expect(within(f.view.container).queryByRole('textbox', { name: '姓名', exact: true })).toBeNull();
  expect(f.runtime.sessions.calls.filter(call => call.method === 'create')).toHaveLength(existing ? 0 : 1);
  expect(f.request.mock.calls.filter(([path]) => path === '/api/clawmaster/workspace')).toHaveLength(existing ? 0 : 1);
  expect(f.request.mock.calls.some(([path]) => path.includes('/command'))).toBe(false);
  expect(f.store.getPrefs().tabsEnabled.browser).toBe(false);
});

it('a later navigation cancels the compiled component settings open before a new Session is selected', async () => {
  const f = await fixture(false);
  let entered;
  const creating = new Promise(resolve => { entered = resolve; });
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  f.runtime.sessions.stubCreate(async () => {
    entered();
    await ready;
    return f.runtime.sessions.add({ id: 'late', summary: { cwd: '/synthetic/desk', blank: true } }, { current: false });
  });
  fireEvent.click(f.settings.getByRole('button', { name: /ERP 库存与订单 (Feature settings|功能设置)/ }));
  fireEvent.click(screen.getByRole('button', { name: '在右侧打开' }));
  await creating;
  act(() => f.layout.selectPanel('clawmaster'));
  await act(async () => { release(); await ready; });
  await waitFor(() => expect(screen.queryByRole('button', { name: '在右侧打开' })).toBeNull());
  expect(f.runtime.panelInfo.getSnapshot().activePanelId).toBe('clawmaster');
  expect(f.runtime.sessions.list.getSnapshot().current).toBeUndefined();
  expect(f.controller.active()).toBeUndefined();
  expect(f.view.container.querySelector('.cm-enterprise')).toBeNull();
  expect(f.request.mock.calls.map(([path]) => path)).toEqual(['/api/clawmaster/workspace']);
});
