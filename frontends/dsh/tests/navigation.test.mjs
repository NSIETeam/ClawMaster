import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductActions, watchdogPrompt } from '../src/navigation.ts';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const calls = [];
  const lifetime = new AbortController();
  let navigation;
  const snapshot = { ids: [], byId: {}, current: undefined, phase: 'ready' };
  const ctx = {
    sessions: {
      list: { getSnapshot: () => snapshot },
      async create(target) { calls.push(['create', target]); return 'session-1'; },
      binding(id) { return { session: { async prompt(content, mode) { calls.push(['prompt', id, content, mode]); return { ok: true, value: { accepted: true } }; } } }; },
    },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
    layout: {
      beginNavigation() { navigation?.abort(); navigation = new AbortController(); return navigation.signal; },
      selectPanel(key) { navigation?.abort(); calls.push(['panel', key]); },
    },
    uiWorkspace: { openSession(id) { snapshot.current = id; calls.push(['open', id]); ctx.layout.selectPanel(null); } },
    betterSidebar: { isTabEnabled: () => true, openTab(seed, scope) { calls.push(['tab', seed, scope]); } },
  };
  const request = async (path, options) => {
    calls.push(['allocate', path, JSON.parse(options.body), options.credentials]);
    return Response.json({ workspaceId: 'workspace-1', path: '/managed/desk' });
  };
  return { ctx, request, calls, snapshot, lifetime, actions: createProductActions(ctx, lifetime.signal, request) };
}

test('mounting product actions allocates no Workspace or Session', () => {
  assert.deepEqual(fixture().calls, []);
});

test('enterprise components reuse the current Session and open in the right sidebar', async () => {
  for (const module of ['crm', 'erp']) {
    const f = fixture();
    f.snapshot.current = 'current';
    f.snapshot.ids = ['current'];
    f.snapshot.byId.current = { id: 'current', cwd: '/project', blank: false };
    await f.actions.open(module, 'en-US');
    assert.equal(f.calls.filter(row => row[0] === 'allocate' || row[0] === 'create').length, 0);
    assert.deepEqual(f.calls.at(-1).slice(0, 2), ['tab', { type: `clawmaster:${module}`, title: module === 'crm' ? 'CRM contacts' : 'ERP inventory and orders', target: 'right' }]);
  }
});

test('new tasks allocate explicitly and submit through the bound DSH Session', async () => {
  const f = fixture();
  await f.actions.start('  检查本机库存  ', 'once', 'zh-CN');
  assert.deepEqual(f.calls, [
    ['allocate', '/api/clawmaster/workspace', { kind: 'task' }, 'same-origin'],
    ['create', { workspaceId: 'workspace-1', cwd: '/managed/desk' }],
    ['open', 'session-1'], ['panel', null], ['prompt', 'session-1', [{ type: 'text', text: '检查本机库存' }], 'queue'],
  ]);
  assert.equal(watchdogPrompt('inspect stock', 'once', 'en-US'), 'inspect stock');
  assert.match(watchdogPrompt('inspect stock', 'hourly', 'en-US'), /schedule_create.*60 minutes/);
});

test('a blank task never invokes a model and duplicate in-flight clicks do not create another Session', async () => {
  const f = fixture();
  const ready = deferred();
  const actions = createProductActions(f.ctx, f.lifetime.signal, async (...args) => { await ready.promise; return f.request(...args); });
  const first = actions.start('', 'once', 'zh-CN');
  const second = actions.start('', 'once', 'zh-CN');
  assert.equal(first, second);
  ready.resolve();
  await first;
  assert.equal(f.calls.filter(row => row[0] === 'create').length, 1);
  assert.equal(f.calls.filter(row => row[0] === 'prompt').length, 0);
});

test('tools preserve the current task context and terminal opens in the bottom panel', async () => {
  const f = fixture();
  f.snapshot.current = 'current';
  f.snapshot.ids = ['current'];
  f.snapshot.byId.current = { id: 'current', cwd: '/project', blank: false };
  await f.actions.open('terminal', 'en-US');
  assert.deepEqual(f.calls, [
    ['open', 'current'], ['panel', null], ['tab', { type: 'terminal', title: 'Terminal', target: 'bottom' }, { sessionId: 'current', cwd: '/project' }],
  ]);
});

test('tools without a current task lazily reuse their desk Session', async () => {
  const f = fixture();
  f.snapshot.ids = ['desk'];
  f.snapshot.byId.desk = { id: 'desk', cwd: '/managed/desk', blank: true };
  await f.actions.open('editor', 'zh-CN');
  assert.equal(f.calls.filter(row => row[0] === 'create').length, 0);
  assert.deepEqual(f.calls.at(-1), ['tab', { type: 'editor', title: '文档编辑器', target: 'right' }, { sessionId: 'desk', cwd: '/managed/desk' }]);
});

test('disabled tools fail visibly without allocating anything', async () => {
  const f = fixture();
  f.ctx.betterSidebar.isTabEnabled = () => false;
  for (const module of ['browser', 'crm', 'erp']) await assert.rejects(f.actions.open(module, 'zh-CN'), { code: 'toolDisabled' });
  assert.deepEqual(f.calls, []);
});

test('superseded navigation or disposed plugins do not open late-created Sessions or send prompts', async () => {
  for (const action of ['navigate', 'dispose']) {
    const f = fixture();
    const entered = deferred();
    const created = deferred();
    f.ctx.sessions.create = async () => { entered.resolve(); await created.promise; return 'late'; };
    const attempt = f.actions.start('must not send', 'daily', 'en-US');
    await entered.promise;
    if (action === 'navigate') f.ctx.layout.selectPanel('clawmaster');
    else f.lifetime.abort();
    created.resolve();
    await attempt;
    assert.equal(f.calls.filter(row => row[0] === 'open' || row[0] === 'prompt').length, 0);
  }
});

test('malformed allocation responses fail before creating a Session', async () => {
  const f = fixture();
  const actions = createProductActions(f.ctx, f.lifetime.signal, async () => Response.json({ workspaceId: null, path: '/project' }));
  await assert.rejects(actions.start('check', 'once', 'en-US'));
  assert.deepEqual(f.calls, []);
});

test('superseded tool navigation never opens a late-created desk Session', async () => {
  for (const [cancellation, module] of [['navigate', 'editor'], ['dispose', 'editor'], ['navigate', 'crm'], ['dispose', 'erp']]) {
    const f = fixture();
    const entered = deferred();
    const created = deferred();
    f.ctx.sessions.create = async () => { entered.resolve(); await created.promise; return 'late'; };
    const opening = f.actions.open(module, 'en-US');
    await entered.promise;
    if (cancellation === 'navigate') f.ctx.layout.selectPanel('clawmaster');
    else f.lifetime.abort();
    created.resolve();
    await opening;
    assert.equal(f.calls.filter(row => row[0] === 'open' || row[0] === 'tab').length, 0);
  }
});
