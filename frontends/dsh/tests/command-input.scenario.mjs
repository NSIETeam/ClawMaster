import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { receiveStreamingRefusal } from './http-stream-fixture.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridge } from '../../../packages/client/connection/src/http-bridge.ts';
import { GovernanceCommandInput } from '../src/command-input.ts';
import { GovernanceAccess } from '../src/governance-access.ts';
import { LOCAL_HTTP_IDENTITY } from '../src/governance-audit.ts';
import { openEnterpriseStore, mountEnterpriseRoutes } from '../src/enterprise-host.ts';
import { applyEnterpriseTools } from '../src/enterprise-tools.ts';
import { mountWatchdogTasks as mountWatchdogTasksImpl } from '../src/watchdog-task-host.ts';
import { watchdogTaskTestContext } from './watchdog-task-test-context.mjs';

const mountWatchdogTasks = (context, ...args) => mountWatchdogTasksImpl(watchdogTaskTestContext(context), ...args);
import { mountWatchdogSchedules } from '../src/watchdog-schedule-host.ts';
import { openWatchdogScheduleStore } from '../src/watchdog-schedule-store.ts';
const names = ['enterprise', 'tasks', 'schedules'];
const pathFor = name => `/api/clawmaster/${name}/command`;
const payload = (name, text = 'Synthetic input') => name === 'enterprise'
  ? { generation: 0, revision: 0, commandId: 'command-one', command: { type: 'contact.upsert', contact: { id: 'contact-one', name: 'Contact', company: '', stage: 'lead', nextAction: text, nextActionDate: null } } }
  : name === 'tasks' ? { id: 'task-one', revision: 0, commandId: 'command-one', command: { type: 'create', task: { goal: 'Review', scope: text,
    owner: { kind: 'local', label: 'Operator' }, dueAt: null, timezone: 'UTC', risk: 'low', checklist: [{ id: 'proof', description: 'Verify' }] } } }
  : { commandId: 'command-one', command: { type: 'create', id: 'plan-one', sessionId: 'session-one', prompt: text, rule: { kind: 'every', everySeconds: 300 }, missed: 'coalesce', catchUpLimit: 1 } };
function barrier() { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; }
async function fixture(t, config = {}, { denied = false, approval, resolveIdentity, readConfig = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-command-input-'));
  const enterprise = await openEnterpriseStore(join(root, 'enterprise.sqlite'), 5000, denied ? 'acme' : 'local', {}, readConfig);
  const schedules = await openWatchdogScheduleStore(join(root, 'schedules.sqlite'), denied ? 'acme' : 'local');
  const commands = new GovernanceCommandInput(config);
  let identities = 0, approvals = 0;
  const access = denied ? new GovernanceAccess({ mode: 'enterprise', organizationId: 'acme', authority: {
    async http() { identities++; return resolveIdentity ? resolveIdentity() : undefined; }, async agent() { identities++; return undefined; },
    async membership() { throw new Error('Unauthenticated caller must not reach membership'); }, async consumeApproval() { throw new Error('No approval expected'); },
  } }) : new GovernanceAccess();
  const routes = new Map(), tools = new Map();
  const ctx = { connection: { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path); } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    approval: { request: async () => { approvals++; return approval ? approval() : 'allowed-once'; } } };
  const removals = [];
  t.after(async () => { await Promise.all(removals.map(remove => remove())); schedules.close(); enterprise.close(); await rm(root, { recursive: true, force: true }); });
  removals.push(await mountEnterpriseRoutes(ctx, enterprise, access, {}, commands));
  removals.push(await applyEnterpriseTools(ctx, enterprise, {}, access, commands));
  removals.push(await mountWatchdogTasks(ctx, enterprise, access, commands));
  removals.push(await mountWatchdogSchedules(ctx, schedules, enterprise, access, commands));
  return { routes, tools, enterprise, schedules, commands, approvals: () => approvals, identities: () => identities,
    dispose: () => Promise.all(removals.map(remove => remove())),
    send: (name, body, options = {}) => routes.get(pathFor(name)).fetch(new Request('http://fixture' + pathFor(name), {
      method: 'POST', headers: { 'content-type': 'application/json', ...options.headers }, body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}), ...(options.signal ? { signal: options.signal } : {}),
    })),
  };
}
function streamed(bytes, chunkSize = 31) {
  let offset = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset + chunkSize); controller.enqueue(bytes.slice(offset, end)); offset = end;
  }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  return { body, consumed: () => offset, cancelled: () => cancelled };
}
function unchanged(h) {
  const identity = { ...LOCAL_HTTP_IDENTITY, organizationId: h.enterprise.organizationId };
  assert.equal(h.enterprise.overview().revision, 0);
  assert.equal(h.enterprise.tasks.list(identity).tasks.length, 0);
  assert.equal(h.schedules.query(identity, Date.now()).records.length, 0);
  assert.equal(h.approvals(), 0);
}
for (const name of names) {
  test(`${name} authenticates before touching a declared oversized body`, async t => {
    const h = await fixture(t, { maxRequestBytes: 1024 }, { denied: true }); const input = streamed(new Uint8Array(2048));
    const response = await h.send(name, input.body, { headers: { 'content-length': '2048' } });
    assert.equal(response.status, 403); assert.equal(input.consumed(), 0); assert.equal(h.identities(), 1); assert.equal(h.enterprise.overview().revision, 0);
  });
  test(`${name} refuses declared and chunked byte excess before approval or mutation`, async t => {
    const h = await fixture(t, { maxRequestBytes: 1024 }); const bytes = Buffer.from(JSON.stringify(payload(name, '汉'.repeat(700))));
    let input = streamed(bytes);
    assert.equal((await h.send(name, input.body, { headers: { 'content-length': String(bytes.length) } })).status, 413); assert.equal(input.consumed(), 0);
    input = streamed(bytes); const response = await h.send(name, input.body);
    assert.equal(response.status, 413); assert.equal((await response.json()).error.code, 'result_too_large');
    assert.ok(input.consumed() <= 1024 + 31); assert.equal(input.body.locked, false); unchanged(h);
  });
  test(`${name} counts split UTF-8 chunks and accepts the exact configured boundary`, async t => {
    const bytes = Buffer.from(JSON.stringify(payload(name, '汉\\"'.repeat(350)))); const h = await fixture(t, { maxRequestBytes: bytes.length });
    const response = await h.send(name, streamed(bytes, 13).body); assert.equal(response.status, 200, await response.clone().text());
    const reject = await fixture(t, { maxRequestBytes: bytes.length - 1 }); assert.equal((await reject.send(name, streamed(bytes, 13).body)).status, 413); unchanged(reject);
  });
  test(`${name} aborts a stalled upload and releases shared command capacity`, async t => {
    const h = await fixture(t, { maxConcurrentCommands: 1 }); const started = barrier(); const controller = new AbortController(); let cancelled = false;
    const body = new ReadableStream({ pull() { started.release(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const response = h.send(name, body, { signal: controller.signal }); await started.wait;
    assert.equal((await h.send('enterprise', JSON.stringify(payload('enterprise')))).status, 503);
    controller.abort(new Error('Test cancelled input')); assert.equal((await response).status, 503); assert.equal(body.locked, false); assert.equal(cancelled, false); unchanged(h);
    assert.equal((await h.send('enterprise', JSON.stringify(payload('enterprise')))).status, 200);
  });
}
test('upload timeout and consumer disposal settle idle reads without approvals or writes', async t => {
  const h = await fixture(t, { maxConcurrentCommands: 1, readTimeoutMs: 50 });
  const response = await h.send('tasks', new ReadableStream({ pull() {} }, { highWaterMark: 0 }));
  assert.equal(response.status, 408); unchanged(h); assert.equal((await h.send('enterprise', JSON.stringify(payload('enterprise')))).status, 200);
  const other = await fixture(t); const gate = barrier();
  const pending = other.send('schedules', new ReadableStream({ pull() { gate.release(); } }, { highWaterMark: 0 }));
  await gate.wait; await other.dispose(); assert.equal((await pending).status, 503); unchanged(other);
});
test('authentication deadlines release admission without reading bodies or continuing late authority results', async t => {
  for (const name of names) {
    const identity = barrier(); let first = true;
    const h = await fixture(t, { readTimeoutMs: 50, maxConcurrentCommands: 1 }, { denied: true,
      resolveIdentity: () => { if (!first) return undefined; first = false; return identity.wait; } });
    const input = streamed(Buffer.from('{}'));
    assert.equal((await h.send(name, input.body)).status, 408); assert.equal(input.consumed(), 0); unchanged(h);
    identity.release({ organizationId: 'acme', memberId: 'late-member', actor: 'human' });
    assert.equal((await h.send(name, '{}')).status, 403); unchanged(h);
  }
});
test('invalid UTF-8 and dishonest lengths refuse the command while the next command remains usable', async t => {
  const h = await fixture(t);
  for (const [body, headers] of [[Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125]), {}], ['{}', { 'content-length': '3' }], ['{}', { 'content-length': '-1' }]]) {
    assert.equal((await h.send('enterprise', body, { headers })).status, 400);
  }
  unchanged(h); assert.equal((await h.send('enterprise', JSON.stringify(payload('enterprise')))).status, 200);
});
test('HTTP and tools share capacity through approval and tools reject excess arguments before approval', async t => {
  const gate = barrier(), entered = barrier();
  const h = await fixture(t, { maxConcurrentCommands: 1 }, { approval: async () => { entered.release(); await gate.wait; return 'allowed-once'; } });
  const exec = { agent: { id: 'session-one' }, callId: 'call-one', name: 'enterprise_command', signal: new AbortController().signal };
  const pending = h.tools.get('enterprise_command').execute({ request: payload('enterprise') }, exec); await entered.wait;
  assert.equal((await h.send('tasks', JSON.stringify(payload('tasks')))).status, 503); gate.release(); await pending;
  assert.equal((await h.send('tasks', JSON.stringify(payload('tasks')))).status, 200);
  const bounded = await fixture(t, { maxRequestBytes: 1024 });
  for (const [tool, args] of [['enterprise_command', { request: payload('enterprise', '汉'.repeat(700)) }],
    ['watchdog_task_command', payload('tasks', '汉'.repeat(700))], ['watchdog_schedule_command', { request: JSON.stringify(payload('schedules', '汉'.repeat(700))) }]]) {
    await assert.rejects(bounded.tools.get(tool).execute(args, { ...exec, name: tool }), /byte input budget/);
  }
  unchanged(bounded);
});
test('real Node HTTP bridge passes command streams before buffering an advertised 299 MiB body', async t => {
  const h = await fixture(t, { maxRequestBytes: 1024 });
  const handler = { requestBodyMode({ url }) { return h.routes.get(url.pathname)?.requestBody ?? 'buffered'; }, fetch: request => h.routes.get(new URL(request.url).pathname).fetch(request) };
  const server = createServer((req, res) => { void bridge(req, res, handler).catch(error => res.destroy(error)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }); const port = server.address().port;
  for (const name of names) {
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: pathFor(name), method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 299 * 1024 * 1024 } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.once('end', () => { req.destroy(); resolve({ status: res.statusCode, body }); });
      });
      req.once('error', reject); req.setTimeout(5000, () => req.destroy(new Error('The bridge buffered a command before its handler could refuse it'))); req.flushHeaders();
    });
    assert.equal(response.status, 413); assert.equal(JSON.parse(response.body).error.code, 'result_too_large');
  }
  unchanged(h);
});
test('registered responsibility pages enforce deployment bytes and row counts without losing audit records', async t => {
  const h = await fixture(t, {}, { readConfig: { maxResponsibilityRows: 2, maxResponsibilityBytes: 1024 } });
  for (let i = 0; i < 9; i++) h.enterprise.recordOutcome(LOCAL_HTTP_IDENTITY, 'contact.upsert', 'denied', `audit-${i}-${'x'.repeat(100)}`, 'permission_denied');
  let after = 0; const ids = [];
  for (;;) {
    const response = await h.routes.get('/api/clawmaster/enterprise/responsibility').fetch(new Request(`http://fixture/api/clawmaster/enterprise/responsibility?limit=2&after=${after}`));
    assert.equal(response.status, 200); const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 1024);
    const value = JSON.parse(text); assert.ok(value.records.length > 0 && value.records.length <= 2); ids.push(...value.records.map(row => row.sequence));
    if (value.nextAfter === null) break;
    assert.ok(value.nextAfter > after); after = value.nextAfter;
  }
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal((await h.routes.get('/api/clawmaster/enterprise/responsibility').fetch(new Request('http://fixture/api/clawmaster/enterprise/responsibility?limit=3'))).status, 400);
});
test('invalid command configuration fails before consumers are registered', () => {
  for (const value of [{ maxRequestBytes: 0 }, { maxConcurrentCommands: 0 }, { readTimeoutMs: 0 }, { readTimeoutMs: Infinity }, { unknownLimit: 1 }]) assert.throws(() => new GovernanceCommandInput(value));
});
for (const [label, body, status] of [['chunked excess', 'x'.repeat(1100), 413], ['idle upload', '{', 408]]) {
  test(`real bridge returns a structured ${status} before closing ${label}`, async t => {
    const h = await fixture(t, { maxRequestBytes: 1024, maxConcurrentCommands: 1, readTimeoutMs: 50 });
    const handler = { requestBodyMode({ url }) { return h.routes.get(url.pathname)?.requestBody ?? 'buffered'; }, fetch: request => h.routes.get(new URL(request.url).pathname).fetch(request) };
    const server = createServer((req, res) => { void bridge(req, res, handler).catch(error => res.destroy(error)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    for (const name of names) {
      const base = `http://127.0.0.1:${server.address().port}`;
      const response = await receiveStreamingRefusal(base + pathFor(name), body);
      assert.equal(response.status, status);
      assert.equal(JSON.parse(response.body).error.code, status === 413 ? 'result_too_large' : 'storage_unavailable');
      const retry = await fetch(base + pathFor(name), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(retry.status, 400, await retry.clone().text());
      assert.equal((await retry.json()).error.code, 'invalid_request', 'The prior upload must release shared admission');
    }
    unchanged(h); assert.equal((await h.send('enterprise', JSON.stringify(payload('enterprise')))).status, 200);
  });
}
