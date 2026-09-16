import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { GovernanceAccess } from '../src/governance-access.ts';
import { LOCAL_HTTP_IDENTITY } from '../src/governance-audit.ts';
import { mountEnterpriseRoutes, openEnterpriseStore } from '../src/enterprise-host.ts';
import { applyEnterpriseTools } from '../src/enterprise-tools.ts';
import { mountWatchdogTasks } from '../src/watchdog-task-host.ts';

const contact = { id: 'customer', name: 'Receipt owner', company: '', stage: 'lead', nextAction: '', nextActionDate: null };
const recordRequest = { generation: 0, revision: 0, commandId: 'records-create', command: { type: 'contact.upsert', contact } };
const taskRequest = { id: 'task', revision: 0, commandId: 'tasks-create', command: { type: 'create', task: {
  goal: 'Review receipt ownership', scope: 'Synthetic records', owner: { kind: 'member', id: 'alice' }, dueAt: null,
  timezone: 'UTC', risk: 'low', checklist: [{ id: 'proof', description: 'Inspect persisted receipt' }],
} } };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'clawmaster-receipts-'));
  const path = join(directory, 'enterprise.sqlite');
  const stores = [];
  const removals = [];
  const ctx = new Context();
  let server;
  t.after(async () => {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const remove of removals.reverse()) await remove();
      await ctx.fiber.dispose();
    } finally { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  const open = async () => { const store = await openEnterpriseStore(path, 5000, 'one'); stores.push(store); return store; };
  const store = await open();
  const principals = new Map(['alice', 'carol'].map(id => [id, { organizationId: 'one', memberId: id, actor: 'human' }]));
  const agents = new Map(['alice', 'carol'].map(id => [id, { organizationId: 'one', memberId: id, actor: 'agent', sessionId: id }]));
  const grants = new Map();
  let authorityApprovals = 0;
  let localApprovals = 0;
  const access = new GovernanceAccess({ mode: 'enterprise', organizationId: 'one', authority: {
    http: async request => principals.get(request.headers.get('authorization')),
    agent: async id => agents.get(id),
    membership: async (organization, member) => organization !== 'one' ? undefined : {
      active: true, policyVersion: 1, roles: [member === 'reviewer' ? 'approver' : 'executor'], resources: ['*'],
    },
    consumeApproval: async request => {
      authorityApprovals++;
      const key = JSON.stringify(request); const result = grants.get(key); grants.delete(key); return result;
    },
  } });
  const routes = new Map();
  const connection = { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } };
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  ctx.on('approval/request', async () => { localApprovals++; return 'allowed-once'; });
  const consumers = { connection, tools: ctx.tools, approval: ctx.approval };
  removals.push(await mountEnterpriseRoutes(consumers, store, access));
  removals.push(await applyEnterpriseTools(consumers, store, {}, access));
  removals.push(await mountWatchdogTasks(consumers, store, access));
  const sessions = new Map(['alice', 'carol'].map(id => {
    const session = Session.create(SessionId(id)); session.append('turn/start', { turn: 1 }); return [id, { id: session.id, session }];
  }));
  server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const route = routes.get(request.url);
      if (!route) { response.writeHead(404); response.end(); return; }
      const result = await route(new Request(`http://127.0.0.1${request.url}`, {
        method: request.method, headers: request.headers, body: Buffer.concat(chunks),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const grant = (family, input, executorId = 'alice') => grants.set(JSON.stringify({
    organizationId: 'one', executorId, action: family === 'records' ? 'records.write' : 'task.write',
    resource: family === 'records' ? contact.id : input.id, commandId: input.commandId, generation: input.generation ?? 0,
    revision: input.revision, commandDigest: createHash('sha256').update(JSON.stringify(input.command)).digest('hex'),
  }), { id: randomUUID(), approverId: 'reviewer' });
  const invoke = async (family, carrier, input, caller = 'alice') => {
    if (carrier === 'tool') {
      const result = await ctx.tools.execute({ callId: randomUUID(), name: family === 'records' ? 'enterprise_command' : 'watchdog_task_command',
        arguments: family === 'records' ? { request: input } : input, agent: sessions.get(caller), signal: new AbortController().signal });
      return result.isError ? { failed: true, text: JSON.stringify(result) } : { failed: false, value: result.value };
    }
    const response = await fetch(`${url}/api/clawmaster/${family === 'records' ? 'enterprise' : 'tasks'}/command`, {
      method: 'POST', headers: { authorization: caller, 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    const value = await response.json();
    return response.ok ? { failed: false, value } : { failed: true, status: response.status, text: JSON.stringify(value) };
  };
  return { store, path, open, agents, principals, access, grant, invoke, counts: () => ({ authorityApprovals, localApprovals }) };
}

for (const family of ['records', 'tasks']) for (const carrier of ['http', 'tool']) {
  test(`${family} ${carrier} receipts reject different principals and actor kinds through real carriers`, async t => {
    const h = await fixture(t);
    const input = family === 'records' ? recordRequest : taskRequest;
    h.grant(family, input);
    const saved = await h.invoke(family, carrier, input);
    assert.equal(saved.failed, false, saved.text);
    const counts = h.counts();
    assert.deepEqual(await h.invoke(family, carrier, input), saved);
    assert.deepEqual(h.counts(), counts, 'an exact retry neither requests approval nor repeats the write');
    for (const [otherCarrier, caller] of [[carrier, 'carol'], [carrier === 'http' ? 'tool' : 'http', 'alice']]) {
      const denied = await h.invoke(family, otherCarrier, input, caller);
      assert.equal(denied.failed, true, `${otherCarrier}/${caller} cannot claim another actor's receipt`);
      assert.match(denied.text, /command_conflict|Command receipt|Task command identifier/);
    }
    if (carrier === 'tool') {
      const original = h.agents.get('alice');
      h.agents.set('alice', { ...original, memberId: 'carol' });
      const reassigned = await h.invoke(family, carrier, input);
      assert.equal(reassigned.failed, true); assert.match(reassigned.text, /command_conflict|Command receipt|Task command identifier/);
      h.agents.set('alice', original);
    }
    const changedRevision = await h.invoke(family, carrier, { ...input, revision: 1 });
    assert.equal(changedRevision.failed, true); assert.match(changedRevision.text, /command_conflict|Command receipt|Task command identifier/);
    assert.deepEqual(await h.invoke(family, carrier, input), saved);
    const identity = carrier === 'http' ? (await h.access.http(new Request('http://fixture', { headers: { authorization: 'alice' } }))).identity
      : (await h.access.agent('alice')).identity;
    const reopened = await h.open();
    if (family === 'records') assert.equal(reopened.prepare(input, identity).receipt.commandId, input.commandId);
    else assert.deepEqual(reopened.tasks.replay(identity, input), saved.value);
    const successes = reopened.responsibility({ commandId: input.commandId }).records.filter(entry => entry.outcome === 'succeeded');
    assert.equal(successes.length, 1);
  });
}

test('legacy and restored receipts keep readable history without gaining an invented owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'clawmaster-legacy-receipts-'));
  const path = join(directory, 'enterprise.sqlite'); const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const open = async () => { const store = await openEnterpriseStore(path); stores.push(store); return store; };
  const store = await open();
  store.execute(recordRequest, LOCAL_HTTP_IDENTITY);
  const localTask = { ...taskRequest, command: { ...taskRequest.command, task: { ...taskRequest.command.task, owner: { kind: 'local', label: 'Owner' } } } };
  store.tasks.execute(LOCAL_HTTP_IDENTITY, localTask);
  const backup = store.backup(LOCAL_HTTP_IDENTITY);
  store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP TABLE command_receipt_identities; PRAGMA user_version=3;'); legacy.close();
  const upgraded = await open();
  assert.equal(upgraded.snapshot().contacts[0].name, contact.name);
  assert.equal(upgraded.tasks.get(LOCAL_HTTP_IDENTITY, localTask.id).revision, 1);
  assert.throws(() => upgraded.prepare(recordRequest, LOCAL_HTTP_IDENTITY), { code: 'command_conflict' });
  assert.throws(() => upgraded.tasks.replay(LOCAL_HTTP_IDENTITY, localTask), { code: 'command_conflict' });
  assert.equal(upgraded.responsibility({ commandId: recordRequest.commandId }).records[0].identity.actor.kind, 'local-human');
  upgraded.restore(backup, 1, 0, LOCAL_HTTP_IDENTITY, 'restore-once');
  assert.throws(() => upgraded.executeReceipt({ ...recordRequest, generation: 1 }, LOCAL_HTTP_IDENTITY), { code: 'command_conflict' });
  assert.equal(upgraded.snapshot().revision, 1);
});

test('restore retries bind the initiating principal as well as organization and actor', async t => {
  const store = await openEnterpriseStore(':memory:', 5000, 'one'); t.after(() => store.close());
  const identity = { actor: { kind: 'agent', id: 'runtime-session' }, principalId: 'alice', organizationId: 'one', source: 'tool', policyVersion: 1 };
  const backup = store.backup(identity);
  store.restore(backup, 0, 0, identity, 'restore');
  assert.equal(store.hasRestoreReceipt(backup, 0, 0, identity, 'restore'), true);
  const reassigned = { ...identity, principalId: 'carol' };
  assert.throws(() => store.hasRestoreReceipt(backup, 0, 0, reassigned, 'restore'), { code: 'command_conflict' });
  assert.throws(() => store.restore(backup, 0, 0, reassigned, 'restore'), { code: 'command_conflict' });
  assert.equal(store.snapshot().generation, 1);
});
