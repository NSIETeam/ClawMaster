import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { GovernanceAccess } from '../src/governance-access.ts';
import { LOCAL_HTTP_IDENTITY } from '../src/governance-audit.ts';
import { mountWatchdogTasks } from '../src/watchdog-task-host.ts';
import { WatchdogTaskClient } from '../src/watchdog-task-client.ts';

const definition = { goal: 'Review customer follow-up', scope: 'Selected customer records', owner: { kind: 'local', label: 'Manager' },
  dueAt: null, timezone: 'Asia/Shanghai', risk: 'medium', checklist: [{ id: 'report', description: 'Inspect the follow-up report' }] };

async function fixture(t, wrap = request => request) {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-client-'));
  const store = await openEnterpriseStore(join(root, 'enterprise.sqlite'));
  const routes = new Map();
  const remove = await mountWatchdogTasks({
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
    tools: { register() { return () => {}; } }, approval: { request: async () => 'allowed-once' },
  }, store, new GovernanceAccess());
  const request = async (path, init) => {
    assert.equal(init.credentials, 'same-origin');
    const url = new URL(path, 'http://fixture');
    return routes.get(url.pathname)(new Request(url, init));
  };
  const client = new WatchdogTaskClient(wrap(request), randomUUID);
  t.after(async () => { client.dispose(); await remove(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { client, store, request };
}

test('lost HTTP write response retries the exact admitted command without duplicating history', async t => {
  let lose = true;
  const bodies = [];
  const { client, store } = await fixture(t, request => async (path, init) => {
    if (init.method === 'POST') bodies.push(init.body);
    const response = await request(path, init);
    if (lose && init.method === 'POST') { lose = false; throw new Error('Response connection dropped after commit'); }
    return response;
  });
  assert.equal(await client.command('task', 0, { type: 'create', task: definition }), false);
  assert.equal(client.getSnapshot().pending, true);
  assert.equal(store.tasks.get(LOCAL_HTTP_IDENTITY, 'task').revision, 1);
  assert.equal(await client.command('task', 1, { type: 'queue' }), false);
  assert.equal(await client.retry(), true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(client.getSnapshot().selected.revision, 1);
  assert.equal(store.tasks.history(LOCAL_HTTP_IDENTITY, 'task').tasks.length, 1);
});

test('list refresh does not substitute a newer revision for the record being reviewed', async t => {
  const { client, store } = await fixture(t);
  await client.command('task', 0, { type: 'create', task: definition });
  store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: 'task', revision: 1, commandId: 'other-client', command: { type: 'queue' } });
  await client.refresh();
  assert.equal(client.getSnapshot().tasks[0].revision, 2);
  assert.equal(client.getSnapshot().selected.revision, 1);
  assert.equal(await client.command('task', 1, { type: 'queue' }), false);
  assert.equal(client.getSnapshot().error, 'conflict');
  assert.equal(client.getSnapshot().pending, false);
  await client.select('task');
  assert.equal(client.getSnapshot().selected.revision, 2);
  assert.deepEqual(client.getSnapshot().history.map(record => record.revision), [1, 2]);
});

test('an earlier read cannot replace a subsequently saved task or loading state', async t => {
  let release;
  let announce;
  const ready = new Promise(resolve => { announce = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const { client } = await fixture(t, request => async (path, init) => {
    const response = await request(path, init);
    if (path.endsWith('?limit=50')) { announce(); await blocked; }
    return response;
  });
  const reading = client.refresh();
  await ready;
  await client.command('task', 0, { type: 'create', task: definition });
  release();
  await reading;
  assert.equal(client.getSnapshot().tasks.length, 1);
  assert.equal(client.getSnapshot().loading, false);
});

test('invalid successful write response remains pending and a valid retry recovers it', async t => {
  let corrupt = true;
  const { client } = await fixture(t, request => async (path, init) => {
    const response = await request(path, init);
    if (corrupt && init.method === 'POST') { corrupt = false; return Response.json({ status: 'accepted' }); }
    return response;
  });
  assert.equal(await client.command('task', 0, { type: 'create', task: definition }), false);
  assert.equal(client.getSnapshot().pending, true);
  assert.equal(client.getSnapshot().error, 'invalid');
  assert.equal(await client.retry(), true);
  assert.equal(client.getSnapshot().selected.status, 'draft');
});

test('explicit HTTP denials clear the pending write and do not mutate task data', async t => {
  const { client, store } = await fixture(t, request => async (path, init) => init.method === 'POST'
    ? Response.json({ error: { code: 'permission_denied', message: 'Reviewer role required' } }, { status: 403 }) : request(path, init));
  assert.equal(await client.command('task', 0, { type: 'create', task: definition }), false);
  assert.equal(client.getSnapshot().error, 'denied');
  assert.equal(client.getSnapshot().pending, false);
  assert.equal(store.tasks.list(LOCAL_HTTP_IDENTITY).tasks.length, 0);
});

test('history pagination retains every revision in order', async t => {
  const { client, store } = await fixture(t);
  for (let revision = 0; revision < 25; revision++) store.tasks.execute(LOCAL_HTTP_IDENTITY, {
    id: 'task', revision, commandId: `edit-${revision}`, command: { type: revision ? 'revise' : 'create', task: { ...definition, goal: `Revision ${revision + 1}` } },
  });
  await client.select('task');
  assert.equal(client.getSnapshot().history.length, 20);
  await client.moreHistory();
  assert.deepEqual(client.getSnapshot().history.map(record => record.revision), Array.from({ length: 25 }, (_, index) => index + 1));
  assert.equal(client.getSnapshot().nextAfter, null);
});
