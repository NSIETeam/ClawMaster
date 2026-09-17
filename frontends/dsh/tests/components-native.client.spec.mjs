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
import { readFile, writeFile } from 'node:fs/promises';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { enterpriseTransport } from './enterprise-transport.fixture.mjs';
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

async function fixture(existing = true, enterpriseStore, localeKey = 'zh') {
  const selectedLocale = { active: localeKey };
  const { sidebar, frontend } = await factories();
  const dataStore = enterpriseStore ?? await openEnterpriseStore(':memory:');
  if (!enterpriseStore) cleanups.push(() => dataStore.close());
  const transport = await enterpriseTransport(dataStore);
  cleanups.push(() => transport.dispose());
  const request = vi.fn(async (path, init) => {
    expect(init.credentials).toBe('same-origin');
    if (path === '/api/clawmaster/workspace') return Response.json({ workspaceId: 'managed', path: '/synthetic/desk' });
    if (path === '/api/clawmaster/schedules?limit=20&after=0') return Response.json({ mode: 'desktop', workers: [], workerSummary: { total: 0, online: 0, offline: 0, degraded: 0, stopped: 0, nextAfter: null }, records: [], nextAfter: null });
    if (path === '/api/clawmaster/tasks?limit=50') return Response.json({ tasks: [], nextCursor: null });
    if (path.startsWith('/api/clawmaster/enterprise')) return transport.fetch(path, init);
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
  await runtime.declare({ main: { kind: 'single', scope: 'root' }, rightbar: { kind: 'single', scope: 'root' }, 'conversation.session.header.corner': { kind: 'single', scope: 'session' } });
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
    slots: { inject(_name, setup) { pluginCleanups.push(setup()); }, register(options, component) { slots.push({ options, component }); return options.name === 'main' ? runtime.slots.register(options, component) : () => {}; } },
    theme: { overrideTokens: () => () => {} },
    sessions: runtime.sessions, workspaces: runtime.workspaces, layout, uiWorkspace, betterSidebar: service,
    locale: { getSnapshot: () => selectedLocale, subscribe: () => () => {} },
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

async function openFromSettings(f, title) {
  fireEvent.click(f.settings.getByRole('button', { name: new RegExp(`${title} (Feature settings|功能设置)`) }));
  fireEvent.click(screen.getByRole('button', { name: '在右侧打开' }));
  await waitFor(() => expect(f.runtime.panelInfo.getSnapshot().activePanelId).toBeNull());
  await waitFor(() => expect(screen.queryByRole('button', { name: '在右侧打开' })).toBeNull());
}

it.each([false, true])('toggles enterprise components without selecting a default Workspace (existing=%s)', async existing => {
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
  expect(f.request).not.toHaveBeenCalled();
  expect(f.store.getPrefs().tabsEnabled.browser).toBe(false);
});

it.each([false, true])('switches CRM and ERP tabs without losing a draft or duplicating the native seat (existing=%s)', async existing => {
  const f = await fixture(existing);
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
  expect(f.runtime.sessions.calls.filter(call => call.method === 'create')).toHaveLength(existing ? 0 : 1);
  expect(f.request.mock.calls.filter(([path]) => path === '/api/clawmaster/workspace')).toHaveLength(existing ? 0 : 1);
  expect(f.request.mock.calls.some(([path]) => path.includes('/command'))).toBe(false);
  expect(f.store.getPrefs().tabsEnabled.browser).toBe(false);
});

it.each([false, true])('closing an enterprise tab aborts its seat and reopening starts without the discarded draft (existing=%s)', async existing => {
  const f = await fixture(existing);
  await openFromSettings(f, 'CRM 客户');
  const crm = f.controller.active();
  await waitFor(() => expect(within(f.view.container).getByRole('button', { name: '新建客户' })).toBeDefined());
  fireEvent.click(within(f.view.container).getByRole('button', { name: '新建客户' }));
  const name = within(f.view.container).getByRole('textbox', { name: '姓名', exact: true });
  fireEvent.change(name, { target: { value: 'Discarded contact draft' } });
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
    return await ready;
  });
  fireEvent.click(f.settings.getByRole('button', { name: /ERP 库存与订单 (Feature settings|功能设置)/ }));
  fireEvent.click(screen.getByRole('button', { name: '在右侧打开' }));
  await creating;
  act(() => f.layout.selectPanel('clawmaster'));
  const late = await f.runtime.sessions.add({ id: 'late', summary: { cwd: '/synthetic/desk', blank: true } }, { current: false });
  await act(async () => { release(late); await ready; });
  await waitFor(() => expect(screen.queryByRole('button', { name: '在右侧打开' })).toBeNull());
  expect(f.runtime.panelInfo.getSnapshot().activePanelId).toBe('clawmaster');
  expect(f.runtime.sessions.list.getSnapshot().current).toBeUndefined();
  expect(f.controller.active()).toBeUndefined();
  expect(f.view.container.querySelector('.cm-enterprise')).toBeNull();
  expect(f.request.mock.calls.map(([path]) => path)).toEqual(['/api/clawmaster/workspace']);
});


async function enterpriseFixture() {
  const store = await openEnterpriseStore(':memory:');
  cleanups.push(() => store.close());
  const contact = { id: 'review-contact', name: 'Synthetic customer', company: 'Original company', stage: 'lead', nextAction: 'Original follow-up', nextActionDate: null };
  const item = { id: 'review-item', sku: 'ITEM', name: 'Synthetic item', stock: 10, reorderAt: 3, supplier: 'Original supplier' };
  const order = { id: 'review-order', kind: 'sale', counterparty: 'Synthetic customer', orderDate: '2026-09-14', currency: 'CNY', lines: [{ itemId: item.id, quantity: 2, unitPriceMinorUnits: 500 }], note: 'Original order note' };
  const write = command => store.execute({ revision: store.snapshot().revision, commandId: crypto.randomUUID(), command });
  write({ type: 'contact.upsert', contact }); write({ type: 'item.upsert', item }); write({ type: 'order.save', order });
  return { ...await fixture(true, store), store, write, contact, item, order };
}

// The production smoke runs this multi-panel path beside other forked suites. Its ten sequential Testing Library waits can each use the 1s default, so allow 50% scheduling headroom without extending individual assertions.
it('a CRM draft survives another component refresh but cannot overwrite its newer record without review', async () => {
  const f = await enterpriseFixture();
  await openFromSettings(f, 'CRM 客户');
  fireEvent.click(within(f.view.container).getByRole('button', { name: '编辑', exact: true }));
  const input = within(f.view.container).getByRole('textbox', { name: '下一步行动', exact: true });
  fireEvent.change(input, { target: { value: 'Retained draft action' } });
  f.write({ type: 'contact.upsert', contact: { ...f.contact, company: 'Newer company from another view' } });
  act(() => f.layout.selectPanel('settings'));
  await openFromSettings(f, 'ERP 库存与订单');
  act(() => f.layout.selectPanel('settings'));
  await openFromSettings(f, 'CRM 客户');
  const panel = within(f.view.container);
  const review = await panel.findByRole('region', { name: '最新记录' });
  expect(input.value).toBe('Retained draft action');
  expect(within(review).getByText('Newer company from another view')).toBeDefined();
  expect(panel.getByRole('button', { name: '保存', exact: true }).disabled).toBe(true);
  const before = f.store.snapshot();
  fireEvent.submit(panel.getByRole('form', { name: '编辑客户' }));
  await waitFor(() => expect(panel.getAllByRole('alert').some(alert => alert.textContent.includes('数据已更新'))).toBe(true));
  expect(f.store.snapshot()).toEqual(before);
  const snapshot = { conflict: review.textContent, draft: input.value, saveDisabled: panel.getByRole('button', { name: '保存', exact: true }).disabled };
  const path = resolve('frontends/dsh/tests/expected/enterprise-draft-review.zh.json');
  if (process.env.DSH_UPDATE_EXPECTED === '1') await writeFile(path, JSON.stringify(snapshot, null, 2) + '\n');
  expect(snapshot).toEqual(JSON.parse(await readFile(path, 'utf8')));
  fireEvent.click(within(review).getByRole('button', { name: '已核对最新记录，保留草稿继续' }));
  fireEvent.click(panel.getByRole('button', { name: '保存', exact: true }));
  await waitFor(() => expect(f.store.snapshot().contacts[0].nextAction).toBe('Retained draft action'));
  expect(f.store.snapshot().revision).toBe(before.revision + 1);
}, 15_000);

it.each(['inventory', 'order'])('an ERP %s draft keeps its reviewed revision until the latest record is explicitly checked', async kind => {
  const f = await enterpriseFixture();
  await openFromSettings(f, 'ERP 库存与订单');
  const panel = within(f.view.container);
  if (kind === 'order') fireEvent.click(panel.getByRole('button', { name: '订单', exact: true }));
  fireEvent.click(await panel.findByRole('button', { name: kind === 'inventory' ? '编辑' : '编辑草稿', exact: true }));
  const input = panel.getByRole('textbox', { name: kind === 'inventory' ? '供应商' : '备注', exact: true });
  fireEvent.change(input, { target: { value: 'Retained ERP draft' } });
  f.write(kind === 'inventory' ? { type: 'item.upsert', item: { ...f.item, stock: 6 } } : { type: 'order.save', order: { ...f.order, counterparty: 'Newer buyer' } });
  fireEvent.click(panel.getByRole('button', { name: '刷新', exact: true }));
  const review = await panel.findByRole('region', { name: '最新记录' });
  expect(input.value).toBe('Retained ERP draft');
  const save = panel.getByRole('button', { name: kind === 'inventory' ? '保存' : '保存草稿', exact: true });
  expect(save.disabled).toBe(true);
  const before = f.store.snapshot();
  fireEvent.submit(panel.getByRole('form', { name: kind === 'inventory' ? '编辑物料' : '编辑草稿' }));
  await waitFor(() => expect(panel.getAllByRole('alert').some(alert => alert.textContent.includes('数据已更新'))).toBe(true));
  expect(f.store.snapshot()).toEqual(before);
  await waitFor(() => expect(within(review).getByRole('button', { name: '已核对最新记录，保留草稿继续' }).disabled).toBe(false));
  fireEvent.click(within(review).getByRole('button', { name: '已核对最新记录，保留草稿继续' }));
  fireEvent.click(save);
  await waitFor(() => expect(f.store.snapshot().revision).toBe(before.revision + 1));
});

it.each(['delete', 'submit'])('a refreshed ERP %s confirmation must be reopened before any mutation', async kind => {
  const f = await enterpriseFixture();
  await openFromSettings(f, 'ERP 库存与订单');
  const panel = within(f.view.container);
  fireEvent.click(panel.getByRole('button', { name: '订单', exact: true }));
  fireEvent.click(await panel.findByRole('button', { name: kind === 'delete' ? '删除' : '确认提交订单', exact: true }));
  f.write({ type: 'item.upsert', item: { ...f.item, stock: 5 } });
  const before = f.store.snapshot();
  fireEvent.click(panel.getByRole('button', { name: '刷新', exact: true }));
  await panel.findByText('记录已更新，本次确认已失效。请取消后重新打开并核对。');
  expect(panel.getByRole('button', { name: kind === 'delete' ? '确认删除' : '提交并更新库存', exact: true }).disabled).toBe(true);
  expect(f.store.snapshot()).toEqual(before);
  fireEvent.click(panel.getByRole('button', { name: '取消', exact: true }));
  fireEvent.click(await panel.findByRole('button', { name: kind === 'delete' ? '删除' : '确认提交订单', exact: true }));
  fireEvent.click(panel.getByRole('button', { name: kind === 'delete' ? '确认删除' : '提交并更新库存', exact: true }));
  await waitFor(() => expect(f.store.snapshot().revision).toBe(before.revision + 1));
});

it.each(['zh', 'en'])('WatchDog keeps a goal across main-slot remounts and surfaces real DSH pending interactions first (%s)', async locale => {
  const f = await fixture(true, undefined, locale);
  const labels = locale === 'zh' ? { goal: '需要关注什么？', cadence: '会话内提醒频率', attention: '待处理 2' } : { goal: 'What should WatchDog watch?', cadence: 'Session reminder frequency', attention: 'Needs attention 2' };
  f.settings.unmount();
  await f.runtime.sessions.add({ id: 'active', summary: { cwd: '/synthetic', displayTitle: 'Active check', blank: false, running: true, updatedAt: 30 } }, { current: false });
  await f.runtime.sessions.add({ id: 'approval', summary: { cwd: '/synthetic', displayTitle: 'Inventory approval', blank: false, running: true, updatedAt: 20 } }, { current: false });
  await f.runtime.sessions.add({ id: 'question', summary: { cwd: '/synthetic', displayTitle: 'Customer question', blank: false, running: true, updatedAt: 10 } }, { current: false });
  const publish = f.runtime.ctx.uiSession.registerPendingInteraction(() => 1);
  const approval = publish({ key: 'approval-1', kind: 'approval', sessionId: 'approval' }, async () => {});
  const question = publish({ key: 'question-1', kind: 'question', sessionId: 'question' }, async () => {});
  cleanups.push(() => { approval(); question(); });
  const mount = () => f.runtime.renderSlot('main', {}, { entryKey: 'clawmaster' });
  let main = mount();
  const goal = 'Review customer follow-ups and inventory';
  fireEvent.change(within(main.container).getByRole('textbox', { name: labels.goal }), { target: { value: goal } });
  fireEvent.change(within(main.container).getByRole('combobox', { name: labels.cadence }), { target: { value: 'daily' } });
  f.runtime.renderSlot('main', {}, { entryKey: 'settings' });
  act(() => f.layout.selectPanel('settings'));
  act(() => f.layout.selectPanel('clawmaster'));
  main = mount();
  const view = within(main.container);
  expect(view.getByRole('textbox', { name: labels.goal }).value).toBe(goal);
  expect(view.getByRole('combobox', { name: labels.cadence }).value).toBe('daily');
  const entries = view.getAllByRole('listitem').map(row => ({ title: row.querySelector('.cm-task-title').textContent, status: row.querySelector('.cm-task-title + span').textContent }));
  const connection = main.container.querySelector('.cm-connection');
  const scheduling = view.getByRole('region', { name: locale === 'zh' ? '定时巡检' : 'Scheduled checks' });
  const snapshot = { draft: goal, cadence: 'daily', entries, connection: { text: connection.textContent, scope: connection.title },
    scheduling: { heading: scheduling.querySelector('h2').textContent, actions: within(scheduling).getAllByRole('button').map(button => button.textContent) } };
  const path = resolve(`frontends/dsh/tests/expected/watchdog-management.${locale}.json`);
  if (process.env.DSH_UPDATE_EXPECTED === '1') await writeFile(path, JSON.stringify(snapshot, null, 2) + '\n');
  expect(snapshot).toEqual(JSON.parse(await readFile(path, 'utf8')));
  fireEvent.click(view.getByRole('button', { name: labels.attention }));
  expect(view.getAllByRole('listitem')).toHaveLength(2);
  fireEvent.click(view.getByRole('button', { name: /Inventory approval/ }));
  expect(f.runtime.sessions.list.getSnapshot().current).toBe('approval');
  act(() => approval());
  await waitFor(() => expect(view.getAllByRole('listitem')).toHaveLength(1));
  expect(view.getByRole('button', { name: /Customer question/ })).toBeDefined();
  f.runtime.renderSlot('main', {}, { entryKey: 'settings' });
});


it.each(['zh', 'en'])('the compiled WatchDog locks uncertain task text and retries the original DSH request (%s)', async locale => {
  const f = await fixture(true, undefined, locale);
  f.settings.unmount();
  const labels = locale === 'zh'
    ? { goal: '需要关注什么？', cadence: '会话内提醒频率', start: '开始检查', retry: '重试原请求', inspect: '打开原会话核查' }
    : { goal: 'What should WatchDog watch?', cadence: 'Session reminder frequency', start: 'Start check', retry: 'Retry original request', inspect: 'Inspect existing session' };
  const admitted = new Set();
  const prompt = vi.fn(async (_content, _mode, _signal, requestId) => {
    admitted.add(requestId);
    return prompt.mock.calls.length === 1
      ? { ok: false, error: { code: 'transport/unavailable', message: 'Response lost after admission' } }
      : { ok: true, value: { accepted: true } };
  });
  const id = await f.runtime.sessions.add({ id: 'retry-task', summary: { cwd: '/synthetic/task', blank: true }, session: { prompt } }, { current: false });
  f.runtime.sessions.stubCreate(async () => id);
  const mount = () => f.runtime.renderSlot('main', {}, { entryKey: 'clawmaster' });
  act(() => f.layout.selectPanel('clawmaster'));
  let main = mount();
  fireEvent.change(within(main.container).getByRole('textbox', { name: labels.goal }), { target: { value: 'Synthetic retained task' } });
  fireEvent.change(within(main.container).getByRole('combobox', { name: labels.cadence }), { target: { value: 'daily' } });
  fireEvent.click(within(main.container).getByRole('button', { name: labels.start }));
  await waitFor(() => expect(within(main.container).getByRole('button', { name: labels.retry }).disabled).toBe(false));
  expect(f.runtime.panelInfo.getSnapshot().activePanelId).toBe('clawmaster');
  const goal = within(main.container).getByRole('textbox', { name: labels.goal });
  const cadence = within(main.container).getByRole('combobox', { name: labels.cadence });
  expect(goal.disabled).toBe(true);
  expect(cadence.disabled).toBe(true);
  fireEvent.change(goal, { target: { value: 'Must not replace an uncertain request' } });
  fireEvent.change(cadence, { target: { value: 'hourly' } });
  const snapshot = { goal: goal.value, cadence: cadence.value, goalDisabled: goal.disabled, cadenceDisabled: cadence.disabled, notice: within(main.container).getByRole('alert').textContent, retry: labels.retry, inspect: labels.inspect };
  const path = resolve(`frontends/dsh/tests/expected/watchdog-admission.${locale}.json`);
  if (process.env.DSH_UPDATE_EXPECTED === '1') await writeFile(path, JSON.stringify(snapshot, null, 2) + '\n');
  expect(snapshot).toEqual(JSON.parse(await readFile(path, 'utf8')));
  expect(goal.value).toBe('Synthetic retained task');
  expect(cadence.value).toBe('daily');
  fireEvent.click(within(main.container).getByRole('button', { name: labels.inspect }));
  expect(f.runtime.sessions.list.getSnapshot().current).toBe(id);
  f.runtime.renderSlot('main', {}, { entryKey: 'settings' });
  act(() => f.layout.selectPanel('clawmaster'));
  main = mount();
  expect(within(main.container).getByRole('textbox', { name: labels.goal }).disabled).toBe(true);
  fireEvent.click(within(main.container).getByRole('button', { name: labels.retry }));
  await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(f.runtime.panelInfo.getSnapshot().activePanelId).toBeNull());
  expect(prompt.mock.calls[1]).toEqual(prompt.mock.calls[0]);
  expect(admitted.size).toBe(1);
  expect(f.runtime.sessions.calls.filter(call => call.method === 'create')).toHaveLength(1);
  expect(f.request.mock.calls.filter(([path]) => path === '/api/clawmaster/workspace')).toHaveLength(1);
  expect(within(main.container).getByRole('textbox', { name: labels.goal }).value).toBe('');
  expect(within(main.container).getByRole('textbox', { name: labels.goal }).disabled).toBe(false);
});
