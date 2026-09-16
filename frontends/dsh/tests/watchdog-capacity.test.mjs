import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { LOCAL_HTTP_IDENTITY } from '../src/governance-audit.ts';
import { GovernanceAccess } from '../src/governance-access.ts';
import { mountWatchdogTasks } from '../src/watchdog-task-host.ts';
import { taskQueryResultSchema } from '../src/watchdog-task-format.ts';
import { DatabaseSync } from 'node:sqlite';

const definition = { goal: 'Follow up', scope: 'Selected work', owner: { kind: 'local', label: 'Local operator' }, dueAt: null,
  timezone: 'UTC', risk: 'low', checklist: [{ id: 'done', description: 'Review the evidence' }] };
const request = (id, revision = 0, command = { type: 'create', task: definition }) => ({ id, revision, commandId: randomUUID(), command });
const wireBytes = value => Buffer.byteLength(JSON.stringify({ isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }));

async function fixture(t, maxResponseBytes = 4096) {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-capacity-'));
  const path = join(root, 'tasks.sqlite');
  const store = await openEnterpriseStore(path, 5000, 'local', { maxResponseBytes });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const ctx = new Context();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const routes = new Map();
  const dispose = await mountWatchdogTasks({ tools: ctx.tools, approval: ctx.approval,
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } } }, store, new GovernanceAccess());
  t.after(async () => { await dispose(); await ctx.fiber.dispose(); });
  ctx.on('approval/request', async () => 'allowed-once');
  const session = Session.create(SessionId(randomUUID()));
  session.append('turn/start', { turn: 1 });
  const tool = (name, args) => ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent: { id: session.id, session }, signal: new AbortController().signal });
  const send = value => routes.get('/api/clawmaster/tasks/command')(new Request('http://fixture/tasks/command', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  }));
  const query = search => routes.get('/api/clawmaster/tasks')(new Request(`http://fixture/tasks?${search}`));
  return { store, path, tool, send, query, maxResponseBytes };
}

test('oversized HTTP and real tool writes reject before task, history or success audit commits', async t => {
  const f = await fixture(t);
  const oversized = { ...definition, checklist: Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, description: 'x'.repeat(4000) })) };
  const input = request('oversized', 0, { type: 'create', task: oversized });
  const http = await f.send(input);
  assert.equal(http.status, 413);
  assert.equal((await http.json()).error.code, 'response_too_large');
  const tool = await f.tool('watchdog_task_command', input);
  assert.equal(tool.isError, true);
  assert.ok(Buffer.byteLength(JSON.stringify(tool)) < f.maxResponseBytes);
  assert.equal(f.store.tasks.list(LOCAL_HTTP_IDENTITY).tasks.length, 0);
  assert.equal(f.store.responsibility().records.some(row => row.outcome === 'succeeded'), false);
  const created = await f.send({ ...input, command: { type: 'create', task: definition } });
  assert.equal(created.status, 200);
  assert.equal(f.store.tasks.history(LOCAL_HTTP_IDENTITY, input.id).tasks.length, 1);
});

test('an oversized revision preserves the prior task, evidence history and success receipt count', async t => {
  const f = await fixture(t);
  const saved = f.store.tasks.execute(LOCAL_HTTP_IDENTITY, request('existing'));
  const receipts = f.store.responsibility().records;
  const input = request('existing', 1, { type: 'revise', task: { ...definition, scope: '界'.repeat(2000) } });
  const result = await f.tool('watchdog_task_command', input);
  assert.equal(result.isError, true);
  assert.deepEqual(f.store.tasks.get(LOCAL_HTTP_IDENTITY, 'existing'), saved);
  assert.equal(f.store.tasks.history(LOCAL_HTTP_IDENTITY, 'existing').tasks.length, 1);
  assert.deepEqual(f.store.responsibility().records.filter(row => row.outcome === 'succeeded'), receipts);
  assert.equal((await f.send({ ...input, command: { type: 'revise', task: { ...definition, goal: 'Short revision' } } })).status, 200);
});

test('invalid deployment budgets fail before creating a database and a configured larger budget is honored', async t => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-invalid-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const maxResponseBytes of [0, 1023, 1.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(openEnterpriseStore(join(root, 'tasks.sqlite'), 5000, 'local', { maxResponseBytes }));
    assert.deepEqual(await readdir(root), []);
  }
  const f = await fixture(t, 2 * 1024 * 1024);
  const task = { ...definition, checklist: Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, description: 'x'.repeat(4000) })) };
  const result = await f.tool('watchdog_task_command', request('large-budget', 0, { type: 'create', task }));
  assert.equal(result.isError, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 65536);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= f.maxResponseBytes);
});

test('UTF-8 and escaped rendered text count toward the complete DSH result, including exact limits', async t => {
  const f = await fixture(t, 32768);
  const input = request('unicode', 0, { type: 'create', task: { ...definition, scope: '💾"\\\n'.repeat(80) } });
  const result = await f.tool('watchdog_task_command', input);
  assert.equal(result.isError, false);
  assert.equal(Buffer.byteLength(JSON.stringify(result)), wireBytes(result.value));
  const maxResponseBytes = wireBytes({ tasks: [result.value], nextCursor: { version: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER, asOf: result.value.createdAt } });
  assert.ok(maxResponseBytes > Buffer.byteLength(JSON.stringify(result.value)));
  const exact = await openEnterpriseStore(':memory:', 5000, 'local', { maxResponseBytes });
  const small = await openEnterpriseStore(':memory:', 5000, 'local', { maxResponseBytes: maxResponseBytes - 1 });
  try {
    assert.equal(exact.tasks.execute(LOCAL_HTTP_IDENTITY, input).id, 'unicode');
    assert.throws(() => small.tasks.execute(LOCAL_HTTP_IDENTITY, input), { code: 'response_too_large' });
    assert.equal(small.tasks.list(LOCAL_HTTP_IDENTITY).tasks.length, 0);
  } finally { exact.close(); small.close(); }
});

test('list pages fit both transports and continue without skipping complete records when bytes shorten a page', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 12; index++) f.store.tasks.execute(LOCAL_HTTP_IDENTITY, request(`task-${index}`));
  const collected = [];
  let cursor;
  do {
    const response = await f.query(`limit=100${cursor ? `&cursor=${encodeURIComponent(JSON.stringify(cursor))}` : ''}`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= f.maxResponseBytes);
    const page = taskQueryResultSchema.parse(JSON.parse(text));
    const tool = await f.tool('watchdog_task_query', { ...(cursor ? { cursor } : {}), limit: 100 });
    assert.equal(tool.isError, false);
    assert.deepEqual(tool.value.tasks, page.tasks);
    if (cursor) assert.deepEqual(tool.value.nextCursor, page.nextCursor);
    assert.ok(Buffer.byteLength(JSON.stringify(tool)) <= f.maxResponseBytes);
    assert.ok(page.tasks.length > 0 && page.tasks.length < 12);
    collected.push(...page.tasks.map(task => task.id));
    if (page.nextCursor !== null) assert.ok(page.nextCursor.offset > (cursor?.offset ?? 0));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(collected.length, 12);
  assert.equal(new Set(collected).size, 12);
});

test('list continuation pins collection version and urgency time across writes and restart', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) f.store.tasks.execute(LOCAL_HTTP_IDENTITY, request(`task-${index}`));
  const first = await (await f.query('limit=1')).json();
  const next = `limit=1&cursor=${encodeURIComponent(JSON.stringify(first.nextCursor))}`;
  const reopened = await openEnterpriseStore(f.path, 5000, 'local', { maxResponseBytes: f.maxResponseBytes });
  try { assert.equal(reopened.tasks.list(LOCAL_HTTP_IDENTITY, { cursor: first.nextCursor, limit: 1 }).tasks.length, 1); }
  finally { reopened.close(); }
  const second = await (await f.query(next)).json();
  assert.equal(second.nextCursor.asOf, first.nextCursor.asOf);
  assert.notEqual(second.tasks[0].id, first.tasks[0].id);
  assert.equal((await f.query('offset=1')).status, 400);
  assert.equal((await f.query('cursor=not-json')).status, 400);
  assert.equal((await f.query('limit=1&limit=2')).status, 400);
  assert.equal((await f.query(`id=task-0&${next}`)).status, 400);
  f.store.tasks.execute(LOCAL_HTTP_IDENTITY, request('task-0', 1, { type: 'queue' }));
  assert.equal((await f.query(next)).status, 409);
  const tool = await f.tool('watchdog_task_query', { cursor: first.nextCursor, limit: 1 });
  assert.equal(tool.isError, true);
  assert.match(JSON.stringify(tool), /revision_conflict|Task list changed/);
  const fresh = await (await f.query('limit=1')).json();
  assert.equal(fresh.nextCursor.version, first.nextCursor.version + 1);
  const replay = request('task-0', 1, { type: 'queue' });
  f.store.tasks.execute(LOCAL_HTTP_IDENTITY, { ...replay, commandId: 'replay-cursor', revision: 2, command: { type: 'wait', reason: 'Waiting' } });
  const page = await (await f.query('limit=1')).json();
  f.store.tasks.execute(LOCAL_HTTP_IDENTITY, { ...replay, commandId: 'replay-cursor', revision: 2, command: { type: 'wait', reason: 'Waiting' } });
  assert.equal((await f.query(`cursor=${encodeURIComponent(JSON.stringify(page.nextCursor))}`)).status, 200);
});

test('schema three task rows gain a collection version without rewriting task history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-list-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'tasks.sqlite');
  const old = await openEnterpriseStore(path);
  const task = old.tasks.execute(LOCAL_HTTP_IDENTITY, request('legacy'));
  old.close();
  const legacy = new DatabaseSync(path);
  try { legacy.exec('DROP TABLE watchdog_task_versions; PRAGMA user_version=3'); } finally { legacy.close(); }
  const migrated = await openEnterpriseStore(path);
  try {
    assert.deepEqual(migrated.tasks.get(LOCAL_HTTP_IDENTITY, 'legacy'), task);
    assert.deepEqual(migrated.tasks.history(LOCAL_HTTP_IDENTITY, 'legacy').tasks, [task]);
    migrated.tasks.execute(LOCAL_HTTP_IDENTITY, request('second'));
    assert.equal(migrated.tasks.list(LOCAL_HTTP_IDENTITY, { limit: 1 }).nextCursor.version, 2);
  } finally { migrated.close(); }
});

test('history exposes a revision cursor beyond 100 immutable revisions and obeys the requested limit', async t => {
  const f = await fixture(t);
  f.store.tasks.execute(LOCAL_HTTP_IDENTITY, request('history'));
  for (let revision = 1; revision < 123; revision++) f.store.tasks.execute(LOCAL_HTTP_IDENTITY, request('history', revision,
    { type: 'revise', task: { ...definition, goal: `Revision ${revision + 1}` } }));
  const revisions = [];
  let after = 0;
  do {
    const response = await f.query(`id=history&history=true&after=${after}&limit=2`);
    const page = taskQueryResultSchema.parse(await response.json());
    const tool = await f.tool('watchdog_task_query', { id: 'history', history: true, after, limit: 2 });
    assert.equal(tool.isError, false);
    assert.deepEqual(tool.value, page);
    assert.ok(Buffer.byteLength(JSON.stringify(tool)) <= f.maxResponseBytes);
    assert.ok(page.tasks.length <= 2);
    revisions.push(...page.tasks.map(task => task.revision));
    if (page.nextAfter !== null) assert.ok(page.nextAfter > after);
    after = page.nextAfter;
  } while (after !== null);
  assert.deepEqual(revisions, Array.from({ length: 123 }, (_, index) => index + 1));
  assert.equal((await f.query('id=history&history=true&offset=1')).status, 400);
});

test('a reduced budget rejects an older oversized record explicitly without truncating or rewriting it', async t => {
  const f = await fixture(t, 16384);
  const input = request('older', 0, { type: 'create', task: { ...definition, scope: '明'.repeat(1000) } });
  const saved = f.store.tasks.execute(LOCAL_HTTP_IDENTITY, input);
  const reduced = await openEnterpriseStore(f.path, 5000, 'local', { maxResponseBytes: 4096 });
  try {
    assert.throws(() => reduced.tasks.get(LOCAL_HTTP_IDENTITY, input.id), { code: 'response_too_large' });
    assert.throws(() => reduced.tasks.list(LOCAL_HTTP_IDENTITY), { code: 'response_too_large' });
    assert.throws(() => reduced.tasks.history(LOCAL_HTTP_IDENTITY, input.id), { code: 'response_too_large' });
    assert.throws(() => reduced.tasks.execute(LOCAL_HTTP_IDENTITY, input), { code: 'response_too_large' });
  } finally { reduced.close(); }
  assert.deepEqual(f.store.tasks.get(LOCAL_HTTP_IDENTITY, input.id), saved);
});

test('large invalid requests produce bounded error responses in HTTP and the real tool pipeline', async t => {
  const f = await fixture(t);
  const input = request('invalid', 0, { type: 'create', task: { ...definition, checklist: Array.from({ length: 100 }, () => ({ id: 'x', description: '' })) } });
  const response = await f.send(input);
  assert.equal(response.status, 400);
  assert.ok(Buffer.byteLength(await response.text()) < f.maxResponseBytes);
  const result = await f.tool('watchdog_task_command', input);
  assert.equal(result.isError, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < f.maxResponseBytes);
});

test('business urgency places review, failure and overdue tasks before newly updated ordinary work', async t => {
  const f = await fixture(t, 16384);
  for (const id of ['review', 'failed', 'overdue', 'ordinary']) {
    const input = request(id, 0, { type: 'create', task: { ...definition, dueAt: id === 'overdue' ? '2000-01-01T00:00:00.000Z' : null } });
    f.store.tasks.execute(LOCAL_HTTP_IDENTITY, input);
    if (id === 'failed' || id === 'review') f.store.tasks.execute(LOCAL_HTTP_IDENTITY, request(id, 1, { type: 'queue' }));
    if (id === 'failed') f.store.tasks.execute(LOCAL_HTTP_IDENTITY, request(id, 2, { type: 'fail', reason: 'Needs attention' }));
    if (id === 'review') {
      f.store.tasks.execute(LOCAL_HTTP_IDENTITY, request(id, 2, { type: 'start', sessionId: 'session' }));
      f.store.tasks.execute(LOCAL_HTTP_IDENTITY, request(id, 3, { type: 'submit', completedCriteria: ['done'],
        evidence: [{ id: 'ev', location: 'file:///fixture.txt', observedAt: '2026-09-16T00:00:00.000Z', summary: 'Review evidence' }] }));
    }
  }
  assert.deepEqual(f.store.tasks.list(LOCAL_HTTP_IDENTITY).tasks.map(task => task.id), ['review', 'failed', 'overdue', 'ordinary']);
});

test('shared task format bundles for browsers without Node imports', async () => {
  const result = await build({ entryPoints: [new URL('../src/watchdog-task-format.ts', import.meta.url).pathname], bundle: true,
    platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.ok(Object.keys(result.metafile.inputs).every(path => !path.includes('watchdog-tasks.ts')));
  assert.doesNotMatch(result.outputFiles[0].text, /from ["']node:/);
});
