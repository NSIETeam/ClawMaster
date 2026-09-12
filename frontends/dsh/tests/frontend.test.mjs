import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseDelimited, readStoredList } from '../src/business.ts';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recentSessions, connectionLabel, watchdogWorkspaceId } from '../src/services.ts';

test('the workbench projects existing DSH rows without inventing tasks or mutating the source', () => {
  const older = Object.freeze({ id: 'older', displayTitle: '旧任务', updatedAt: 10, running: false, blank: false });
  const newer = Object.freeze({ id: 'newer', displayTitle: '真实项目', updatedAt: 20, running: true, blank: false });
  const blank = Object.freeze({ id: 'blank', displayTitle: '空会话', updatedAt: 99, running: false, blank: true });
  const child = Object.freeze({ id: 'child', displayTitle: '子任务', updatedAt: 100, running: false, blank: false, origin: 'subagent' });
  const snapshot = Object.freeze({
    ids: Object.freeze(['older', 'newer', 'blank', 'child', 'stale']),
    byId: Object.freeze({ older, newer, blank, child }), phase: 'ready',
  });
  assert.deepEqual(recentSessions(snapshot, []).map(row => row.id), ['newer', 'older']);
  assert.equal(recentSessions(snapshot, [])[0].running, true);
  const archived = Object.freeze(['newer']);
  assert.deepEqual(recentSessions(snapshot, archived).map(row => row.id), ['older']);
  assert.deepEqual(archived, ['newer']);
  assert.deepEqual(snapshot.ids, ['older', 'newer', 'blank', 'child', 'stale']);
  assert.deepEqual(recentSessions({ ids: [], byId: {}, phase: 'pending' }, []), []);
});

test('unknown or disconnected state is never displayed as connected', () => {
  assert.equal(connectionLabel('connected'), '已连接');
  assert.equal(connectionLabel(undefined), '正在连接');
  assert.equal(connectionLabel('connecting'), '正在连接');
  assert.equal(connectionLabel('disconnected'), '连接已断开');
});

test('WatchDog resolves only its system-managed workspace', () => {
  const snapshot = {
    phase: 'ready', archivedSessionIds: [],
    items: [
      { workspaceId: 'recent', path: '/projects/recent', title: 'Recent project' },
      { workspaceId: 'watchdog', path: '/managed/watchdog', title: 'WatchDog 托管空间' },
    ],
  };
  assert.equal(watchdogWorkspaceId(snapshot), 'watchdog');
  assert.equal(watchdogWorkspaceId({ ...snapshot, items: snapshot.items.slice(0, 1) }), undefined);
});

test('the data processor parses CSV and TSV without losing quoted commas', () => {
  assert.deepEqual(parseDelimited('name,value\n"华东,一区",12').rows, [
    ['name', 'value'], ['华东,一区', '12'],
  ]);
  assert.deepEqual(parseDelimited('sku\tstock\nA-1\t8'), {
    delimiter: '\t', rows: [['sku', 'stock'], ['A-1', '8']],
  });
});

test('business module storage ignores malformed and invalid records', () => {
  const isNamed = value => typeof value === 'object' && value !== null && typeof value.name === 'string';
  assert.deepEqual(readStoredList('[{"name":"远航科技"},{"bad":1}]', isNamed), [{ name: '远航科技' }]);
  assert.deepEqual(readStoredList('{broken', isNamed), []);
});

test('the distributed factory uses shared React and leaves the DSH backend and other UI slots intact', async () => {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const rows = new Map();
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
    document: doc,
    MutationObserver: FakeMutationObserver,
  });
  assert.equal(registration.id, manifest.name);
  const sharedRequire = createRequire(import.meta.url);
  const imports = new Set();
  const plugin = registration.factory(id => {
    imports.add(id);
    assert.ok(['react', 'react/jsx-runtime'].includes(id), `unexpected runtime import: ${id}`);
    return sharedRequire(id);
  });
  const emptySource = { subscribe: () => () => {}, getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }) };
  const services = {
    slots: {
      inject(_name, setup) { cleanups.push(setup()); },
      register(options, component) {
        rows.set(options.name, { options, component });
        return () => { disposedSlots++; };
      },
    },
    theme: {
      overrideTokens(_id, tokens) {
        for (const token of Object.values(tokens)) assert.ok(token.light && token.dark);
        themeCount++;
        return () => { themeCount--; };
      },
    },
    sessions: { list: emptySource, refresh: () => { throw new Error('should only refresh after user action'); } },
    workspaces: { list: { subscribe: () => () => {}, getSnapshot: () => ({
      items: [{ workspaceId: 'watchdog', path: '/managed/watchdog', title: 'WatchDog 托管空间' }],
      archivedSessionIds: [], phase: 'ready',
    }) } },
    connection: { state: { subscribe: () => () => {}, getSnapshot: () => 'connected' } },
    uiWorkspace: {
      startSession() { throw new Error('must not create a session on plugin load'); },
      openSession() { throw new Error('must not change selected session on plugin load'); },
    },
    effect(setup) { cleanups.push(setup()); },
  };
  plugin.apply(services);
  assert.equal(doc.title, 'ClawMaster');
  assert.equal(styleCount, 1);
  assert.equal(themeCount, 1);
  assert.ok(imports.has('react'));
  assert.deepEqual([...rows.keys()].sort(), [
    'conversation.hero.brand.mark', 'main', 'sidebar.brand.mark', 'sidebar.brand.name', 'sidebar.panellist',
  ].sort());
  assert.equal(rows.get('main').options.key, 'clawmaster');
  assert.equal(rows.get('sidebar.panellist').options.id, 'clawmaster');
  assert.ok(plugin.inject.includes('workspaces'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-workspace-controller'));
  const brand = renderToStaticMarkup(React.createElement(rows.get('sidebar.brand.name').component));
  assert.match(brand, /ClawMaster/);
  const html = renderToStaticMarkup(React.createElement(rows.get('main').component));
  assert.match(html, /已连接/);
  assert.match(html, /开启AI时代的企业协作/);
  assert.match(html, /WatchDog 运行中/);
  assert.match(html, /无需预设工作空间/);
  assert.doesNotMatch(html, /真实项目|旧任务/);
  services.workspaces.list.getSnapshot = () => ({ items: [], archivedSessionIds: [], phase: 'pending' });
  const pendingHtml = renderToStaticMarkup(React.createElement(rows.get('main').component));
  assert.match(pendingHtml, /正在读取会话/);
  assert.doesNotMatch(pendingHtml, /还没有任务/);
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(styleCount, 0);
  assert.equal(themeCount, 0);
  assert.equal(disposedSlots, 5);

  const host = await import('../dist/index.js');
  assert.deepEqual(Object.keys(host), ['apply', 'inject', 'name']);
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-watchdog-'));
  const created = [];
  await host.apply({ workspaceRegistry: { create: async (...args) => { created.push(args); } } }, { managedRoot: join(root, 'managed') });
  assert.equal((await stat(join(root, 'managed'))).isDirectory(), true);
  assert.deepEqual(created, [[join(root, 'managed'), 'WatchDog 托管空间']]);
});
