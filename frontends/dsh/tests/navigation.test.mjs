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
      binding(id) { return { session: { beginSubmission() { return { requestId: 'submission-1', abandon() {} }; }, async prompt(content, mode) { calls.push(['prompt', id, content, mode]); return { ok: true, value: { accepted: true } }; } } }; },
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
    ['prompt', 'session-1', [{ type: 'text', text: '检查本机库存' }], 'queue'], ['open', 'session-1'], ['panel', null],
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


test('a task draft survives other panel navigation and clears only after admission', async () => {
  const f = fixture();
  let changes = 0;
  const unsubscribe = f.actions.draft.subscribe(() => changes++);
  f.actions.updateDraft('Retain this review goal', 'daily');
  f.ctx.layout.selectPanel('settings');
  assert.equal(f.actions.draft.getSnapshot().goal, 'Retain this review goal');
  assert.equal(f.actions.draft.getSnapshot().cadence, 'daily');
  await f.actions.open('crm', 'en-US');
  assert.equal(f.actions.draft.getSnapshot().goal, 'Retain this review goal');
  await f.actions.start('Retain this review goal', 'daily', 'en-US');
  assert.deepEqual(f.actions.draft.getSnapshot(), { goal: '', cadence: 'once', failed: false, busy: false, locked: false, sessionId: undefined });
  unsubscribe();
  const count = changes;
  f.actions.updateDraft('Next goal', 'once');
  assert.equal(changes, count);
});

test('a lost admission response retries the original Session and request identity', async () => {
  const f = fixture();
  const requests = [];
  const admitted = new Set();
  let loseResponse = true;
  let minted = 0;
  f.ctx.sessions.binding = id => ({ session: {
    beginSubmission: () => ({ requestId: `retained-request-${++minted}`, abandon() {} }),
    async prompt(content, _mode, _signal, requestId) {
      requests.push({ id, content, requestId });
      admitted.add(requestId);
      if (loseResponse) { loseResponse = false; return { ok: false, error: { code: 'transport/unavailable', message: 'Response lost' } }; }
      return { ok: true, value: { accepted: true } };
    },
  } });
  await assert.rejects(f.actions.start('Retain original goal', 'hourly', 'en-US'), { code: 'actionError' });
  assert.equal(f.actions.draft.getSnapshot().goal, 'Retain original goal');
  assert.equal(f.actions.draft.getSnapshot().failed, true);
  assert.equal(f.actions.draft.getSnapshot().sessionId, 'session-1');
  assert.equal(f.calls.filter(call => call[0] === 'open').length, 0, 'failed admission keeps the management page open');
  f.actions.updateDraft('Changed goal must not be submitted', 'daily');
  assert.equal(f.actions.draft.getSnapshot().goal, 'Retain original goal');
  assert.equal(f.actions.draft.getSnapshot().cadence, 'hourly');
  assert.equal(f.actions.draft.getSnapshot().locked, true);
  await assert.rejects(f.actions.start('Changed goal must not be submitted', 'daily', 'en-US'), { code: 'actionError' });
  assert.equal(requests.length, 1);
  assert.equal(minted, 1);
  f.actions.openDraftSession();
  f.ctx.layout.selectPanel('clawmaster');
  await f.actions.start('Retain original goal', 'hourly', 'zh-CN');
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'allocate').length, 1);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(admitted.size, 1);
  assert.equal(minted, 1);
  assert.equal(f.actions.draft.getSnapshot().locked, false);
  assert.equal(f.actions.draft.getSnapshot().goal, '');
});

test('opening a blank task preserves a goal that has not been submitted', async () => {
  const f = fixture();
  f.actions.updateDraft('Unsubmitted review', 'daily');
  await f.actions.start('', 'once', 'en-US');
  assert.equal(f.actions.draft.getSnapshot().goal, 'Unsubmitted review');
  assert.equal(f.actions.draft.getSnapshot().cadence, 'daily');
  assert.equal(f.calls.filter(call => call[0] === 'prompt').length, 0);
});


test('an exception during prompt admission retires the local echo and keeps the draft for retry', async () => {
  const f = fixture();
  let abandoned = 0;
  f.ctx.sessions.binding = () => ({ session: {
    beginSubmission: () => ({ requestId: 'exception-request', abandon() { abandoned++; } }),
    async prompt() { throw new Error('carrier interrupted'); },
  } });
  await assert.rejects(f.actions.start('Preserve on throw', 'once', 'en-US'), /carrier interrupted/);
  assert.equal(abandoned, 1);
  assert.equal(f.actions.draft.getSnapshot().goal, 'Preserve on throw');
  assert.equal(f.actions.draft.getSnapshot().failed, true);
  assert.equal(f.actions.draft.getSnapshot().busy, false);
});

test('failure before prompt submission leaves the goal and cadence editable', async () => {
  const f = fixture();
  f.ctx.sessions.binding = () => undefined;
  await assert.rejects(f.actions.start('Before admission', 'once', 'en-US'), { code: 'actionError' });
  assert.equal(f.actions.draft.getSnapshot().locked, false);
  f.actions.updateDraft('Corrected before sending', 'daily');
  assert.equal(f.actions.draft.getSnapshot().goal, 'Corrected before sending');
  assert.equal(f.actions.draft.getSnapshot().cadence, 'daily');
  assert.equal(f.calls.filter(call => call[0] === 'prompt').length, 0);
});
