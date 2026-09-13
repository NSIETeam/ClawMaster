import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recentSessions, connectionLabel } from '../src/services.ts';

const sourceOf = value => ({ subscribe: () => () => {}, getSnapshot: () => value });

test('the workbench projects real DSH rows without blank, archived or delegated tasks', () => {
  const older = Object.freeze({ id: 'older', displayTitle: '旧任务', updatedAt: 10, running: false, blank: false });
  const newer = Object.freeze({ id: 'newer', displayTitle: '真实项目', updatedAt: 20, running: true, blank: false });
  const blank = Object.freeze({ id: 'blank', displayTitle: '空会话', updatedAt: 99, running: false, blank: true });
  const child = Object.freeze({ id: 'child', displayTitle: '子任务', updatedAt: 100, running: false, blank: false, origin: 'subagent' });
  const snapshot = Object.freeze({ ids: Object.freeze(['older', 'newer', 'blank', 'child', 'stale']), byId: Object.freeze({ older, newer, blank, child }), phase: 'ready' });
  assert.deepEqual(recentSessions(snapshot, []).map(row => row.id), ['newer', 'older']);
  assert.equal(recentSessions(snapshot, [])[0].running, true);
  assert.deepEqual(recentSessions(snapshot, ['newer']).map(row => row.id), ['older']);
  assert.deepEqual(snapshot.ids, ['older', 'newer', 'blank', 'child', 'stale']);
  assert.deepEqual(recentSessions({ ids: [], byId: {}, phase: 'pending' }, []), []);
});

test('unknown connection state never displays connected in either locale', () => {
  assert.equal(connectionLabel('connected'), '已连接');
  assert.equal(connectionLabel(undefined), '正在连接');
  assert.equal(connectionLabel('disconnected'), '连接已断开');
  assert.equal(connectionLabel(undefined, 'en-US'), 'Connecting');
});

test('the shipped factory registers WatchDog and enterprise sidebar components and cleans up without creating Sessions', async () => {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const rows = new Map();
  const tabs = new Map();
  const cleanups = [];
  let styleCount = 0;
  let themeCount = 0;
  let disposedSlots = 0;
  let registration;
  class FakeMutationObserver { observe() {} disconnect() {} }
  const doc = {
    createElement: () => ({ dataset: {}, textContent: '', remove() { styleCount--; } }),
    head: { appendChild() { styleCount++; } },
  };
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: value => { registration = value; } } },
    document: doc, MutationObserver: FakeMutationObserver, AbortController, EventTarget, Event,
    fetch() { throw new Error('must not request on plugin load'); },
  });
  assert.equal(registration.id, manifest.name);
  const sharedRequire = createRequire(import.meta.url);
  const runtimeImports = new Set();
  const plugin = registration.factory(id => {
    assert.ok(['react', 'react/jsx-runtime', 'react-dom'].includes(id), `unexpected runtime import: ${id}`);
    runtimeImports.add(id);
    return sharedRequire(id);
  });
  assert.ok(runtimeImports.has('react-dom'), 'navigation must use the Host ReactDOM singleton');
  const buildMeta = JSON.parse(await readFile(new URL('../dist/build-meta.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(buildMeta.inputs).some(path => path.includes('node_modules/react-dom/')), false);
  const services = {
    slots: {
      inject(_name, setup) { cleanups.push(setup()); },
      register(options, component) {
        if (options.id === 'clawmaster-initial-entry') assert.ok(rows.has('main:clawmaster'));
        rows.set(`${options.name}:${options.key ?? options.id ?? ''}`, { options, component });
        return () => { disposedSlots++; };
      },
    },
    theme: { overrideTokens(_id, tokens) {
      for (const token of Object.values(tokens)) assert.ok(token.light && token.dark);
      themeCount++; return () => { themeCount--; };
    } },
    sessions: { list: sourceOf({ ids: [], byId: {}, phase: 'ready' }),
      create() { throw new Error('must not create on load'); },
      refresh() { throw new Error('must only refresh after user action'); } },
    workspaces: { list: sourceOf({ items: [], archivedSessionIds: [], phase: 'ready' }) },
    connection: { state: sourceOf('connected') },
    locale: sourceOf({ active: 'zh' }),
    settingsScope: { bind() { return sourceOf({ mode: 'host', status: 'ready', value: { acknowledgedVersion: 0 } }); } },
    layout: { selectPanel() { throw new Error('must not navigate on load'); } },
    betterSidebar: { registerTab(tab) { tabs.set(tab.id, tab); return () => tabs.delete(tab.id); } },
    uiWorkspace: { openSession() { throw new Error('must not change selection on load'); } },
    effect(setup) { cleanups.push(setup()); },
  };
  plugin.apply(services);
  assert.equal(doc.title, 'ClawMaster');
  assert.equal(styleCount, 1);
  assert.equal(themeCount, 1);
  assert.equal(rows.size, 8);
  assert.ok(rows.has('main:clawmaster'));
  assert.ok(rows.has('sidebar.panellist:clawmaster'));
  const artwork = await Promise.all(['clawmaster.svg', 'clawmaster-dark.svg']
    .map(name => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')));
  for (const slot of ['sidebar.brand.mark:', 'conversation.hero.brand.mark:']) {
    const mark = renderToStaticMarkup(React.createElement(rows.get(slot).component));
    const sources = [...mark.matchAll(/src="([^"]+)"/gu)].map(match => match[1]
      .replaceAll('&quot;', '"').replaceAll('&#x27;', "'")
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
    assert.equal(sources.length, 2, `${slot} provides both theme variants`);
    for (const [index, src] of sources.entries()) {
      assert.ok(src.startsWith('data:image/svg+xml'), `${slot} renders the vector artwork`);
      const separator = src.indexOf(',');
      const decoded = src.slice(0, separator).endsWith(';base64')
        ? Buffer.from(src.slice(separator + 1), 'base64').toString('utf8')
        : decodeURIComponent(src.slice(separator + 1));
      assert.equal(decoded, artwork[index]);
    }
    assert.match(mark, /class="cm-dsh-brand-light"/u);
    assert.match(mark, /class="cm-dsh-brand-dark"/u);
  }
  assert.deepEqual([...tabs.keys()], ['clawmaster:crm', 'clawmaster:erp']);
  for (const tab of tabs.values()) {
    assert.equal(tab.single, true);
    assert.match(renderToStaticMarkup(tab.settings.render({ close() {} })), /在右侧打开/);
  }
  assert.ok(manifest.dsh.client.inject.includes('dsh-better-sidebar'));
  assert.equal(tabs.get('clawmaster:crm').title(), 'CRM 客户');
  const initialEntry = rows.get('shell.overlay:clawmaster-initial-entry').component;
  assert.equal(renderToStaticMarkup(React.createElement(initialEntry, {
    usePanelInfo: selector => selector({ activePanelId: null }),
  })), '');
  const main = rows.get('main:clawmaster').component;
  const html = renderToStaticMarkup(React.createElement(main, { useSessionPendingInteraction: selector => selector(new Map()) }));
  assert.match(html, /已连接/);
  assert.match(html, /开启AI时代的企业协作/);
  assert.match(html, /还没有任务/);
  assert.match(html, /文档编辑器/);
  assert.match(html, /系统按任务创建工作空间/);
  assert.doesNotMatch(html, /WatchDog 运行中|DeepSeek Harness|HARNESS|数据处理器|CRM 客户|ERP 库存/);
  services.sessions.list.getSnapshot = () => ({
    ids: ['finished'], byId: { finished: { id: 'finished', displayTitle: '完成的测试任务', updatedAt: 1, running: false, blank: false } }, phase: 'ready',
  });
  const taskHtml = renderToStaticMarkup(React.createElement(main, { useSessionPendingInteraction: selector => selector(new Map()) }));
  assert.match(taskHtml, /完成的测试任务/);
  assert.match(taskHtml, /class="cm-idle">当前未运行/);
  assert.doesNotMatch(taskHtml, /已停止执行/);
  services.locale.getSnapshot = () => ({ active: 'en' });
  assert.equal(tabs.get('clawmaster:crm').title(), 'CRM contacts');
  assert.match(renderToStaticMarkup(React.createElement(main, { useSessionPendingInteraction: selector => selector(new Map()) })), /What should WatchDog watch/);
  assert.match(renderToStaticMarkup(React.createElement(main, { useSessionPendingInteraction: selector => selector(new Map()) })), /class="cm-idle">Not running/);
  services.sessions.list.getSnapshot = () => ({ ids: [], byId: {}, phase: 'pending' });
  assert.match(renderToStaticMarkup(React.createElement(main, { useSessionPendingInteraction: selector => selector(new Map()) })), /Loading sessions/);
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(styleCount, 0);
  assert.equal(themeCount, 0);
  assert.equal(disposedSlots, 8);
  assert.equal(tabs.size, 0);
});

test('the distributed Host allocates workspaces only on explicit requests and preserves separate tasks', async t => {
  const host = await import('../dist/index.js');
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-workspaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const routes = new Map();
  const created = new Map();
  const cleanups = [];
  const ctx = {
    settings: { register(namespace, schema) { assert.equal(namespace, 'clawmaster-watchdog-onboarding'); assert.deepEqual(schema({}), { acknowledgedVersion: 0 }); } },
    workspaceRegistry: { async create(path) {
      if (!created.has(path)) created.set(path, { id: `workspace-${created.size}`, path });
      return created.get(path);
    } },
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } },
    tools: { register() { return () => {}; }, guard() { return () => {}; } },
    systemPrompt: { context() { return () => {}; } },
    on() { return () => {}; },
    approval: { request() { throw new Error('workspace allocation must not request approval'); } },
    fs: { sandboxMode: 'workspace-write' },
    sandboxPolicy: { resolve() { throw new Error('workspace allocation must not invoke CSV'); } },
    effect(setup) {
      const result = setup();
      if (result instanceof Promise) return result.then(cleanup => { cleanups.push(cleanup); });
      cleanups.push(result);
    },
  };
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const managedRoot = join(root, 'workspaces');
  await host.apply(ctx, { managedRoot, databasePath: join(root, 'data.sqlite') });
  assert.equal(created.size, 0);
  await assert.rejects(stat(managedRoot), { code: 'ENOENT' });
  const request = body => routes.get('/api/clawmaster/workspace').fetch(new Request('http://localhost/api/clawmaster/workspace', { method: 'POST', body }));
  for (const body of ['{broken', '{}', '{"kind":"bad"}', '{"kind":"task","path":"/outside"}']) {
    assert.equal((await request(body)).status, 400);
  }
  assert.equal(created.size, 0);
  const tools = await (await request('{"kind":"tools"}')).json();
  const again = await (await request('{"kind":"tools"}')).json();
  assert.deepEqual(tools, again);
  assert.equal(tools.path, join(managedRoot, 'desk'));
  const tasks = await Promise.all([request('{"kind":"task"}'), request('{"kind":"task"}')]);
  const [first, second] = await Promise.all(tasks.map(response => response.json()));
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.notEqual(first.path, second.path);
  assert.ok((await stat(first.path)).isDirectory());
  assert.equal(created.size, 3);
});


test('workspace disposal drains an entered registry write and rejects further allocations', async t => {
  const { applyManagedWorkspaces } = await import('../src/workspace-host.ts');
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-workspace-dispose-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let entered;
  let finish;
  const registryEntered = new Promise(resolve => { entered = resolve; });
  const registryFinish = new Promise(resolve => { finish = resolve; });
  let route;
  let registered = true;
  let creates = 0;
  const dispose = applyManagedWorkspaces({
    workspaceRegistry: { async create(path) { creates++; entered(); await registryFinish; return { id: 'owned', path }; } },
    connection: { fetch: { register(value) { route = value; return async () => { registered = false; }; } } },
  }, root);
  t.after(() => { finish(); return dispose(); });
  const request = () => new Request('http://localhost/api/clawmaster/workspace', { method: 'POST', body: '{"kind":"task"}' });
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await route.fetch(new Request(request(), { signal: aborted.signal }))).status, 503);
  const active = route.fetch(request());
  await registryEntered;
  let settled = false;
  const stopping = dispose().then(() => { settled = true; });
  assert.equal(registered, false);
  assert.equal((await route.fetch(request())).status, 503);
  assert.equal(settled, false);
  finish();
  assert.equal((await active).status, 200);
  await stopping;
  assert.equal(settled, true);
  assert.equal(creates, 1);
});


test('WatchDog prioritizes DSH pending approvals, questions and plan reviews without inferring business completion', () => {
  const rows = ['running', 'approval', 'question', 'plan', 'idle', 'extension'].map((id, index) => ({
    id, displayTitle: id, updatedAt: 10 - index, running: id !== 'idle', blank: false, completed: id === 'idle',
  }));
  const snapshot = { ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])), phase: 'ready' };
  const pending = new Map([['approval', { kind: 'approval' }], ['question', { kind: 'question' }], ['plan', { kind: 'plan-review' }], ['extension', { kind: 'other-domain' }]]);
  const projected = recentSessions(snapshot, [], 'en-US', pending);
  assert.deepEqual(projected.map(row => [row.id, row.status, row.attention]), [
    ['approval', 'approval', true], ['question', 'question', true], ['plan', 'planReview', true],
    ['running', 'running', false], ['idle', 'idle', false], ['extension', 'running', false],
  ]);
});
