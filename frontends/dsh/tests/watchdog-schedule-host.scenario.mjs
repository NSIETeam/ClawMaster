import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { openWatchdogScheduleStore } from '../src/watchdog-schedule-store.ts';
import { WatchdogScheduleRuntime } from '../src/watchdog-schedule-runtime.ts';
import { mountWatchdogSchedules } from '../src/watchdog-schedule-host.ts';
import { GovernanceAccess } from '../src/governance-access.ts';
import { LOCAL_HTTP_IDENTITY as human } from '../src/governance-audit.ts';
import { scheduleCommandSchema, scheduleResponseBytes } from '../src/watchdog-schedule-format.ts';

class RecordingAdapter extends LlmAdapter {
  requests = [];
  async *stream(options) {
    this.requests.push(options);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Inspection recorded; review evidence separately.' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function fixture(t, access = new GovernanceAccess(), identity = human, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-schedule-host-'));
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' });
  await ctx.plugin(LocalJobRegistry);
  await ctx.plugin(ApprovalService);
  const adapter = new RecordingAdapter(); ctx.llm.registerAdapter(['mock'], adapter);
  const handle = await ctx.agents.create({ sessionId: SessionId('session'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } });
  const store = await openWatchdogScheduleStore(join(root, 'schedules.sqlite'), identity.organizationId, { pollMs: 1000, leaseMs: 30000, ...options });
  const enterprise = await openEnterpriseStore(join(root, 'enterprise.sqlite'), 5000, identity.organizationId);
  const routes = new Map(); const definitions = new Map();
  const services = { agents: ctx.agents, sessions: ctx.sessions, jobs: ctx.jobs, approval: ctx.approval,
    tools: { register(definition) { definitions.set(definition.name, definition); return ctx.tools.register(definition); } },
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } } };
  const remove = await mountWatchdogSchedules(services, store, enterprise, access);
  const runtime = new WatchdogScheduleRuntime(services, store, access);
  const detach = ctx.jobs.attachController('schedule-test');
  t.after(async () => { await runtime.dispose(); await remove(); detach(); await handle.dispose(); await ctx.fiber.dispose(); store.close(); enterprise.close(); await rm(root, { recursive: true, force: true }); });
  const send = (command, extras = {}) => routes.get('/api/clawmaster/schedules/command')(new Request('http://fixture/api/clawmaster/schedules/command', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: randomUUID(), command, ...extras }) }));
  const read = (search = '') => routes.get('/api/clawmaster/schedules')(new Request(`http://fixture/api/clawmaster/schedules${search}`));
  const seed = () => {
    const now = Date.now();
    store.command(identity, scheduleCommandSchema.parse({ commandId: randomUUID(), command: { type: 'create', id: 'plan', sessionId: 'session', prompt: 'Inspect selected customer records. Do not make changes.', rule: { kind: 'every', everySeconds: 300 }, missed: 'coalesce', catchUpLimit: 2 } }), now - 300000);
    store.materialize(now);
    return store.query(identity, now, 'plan').records[0];
  };
  const waitJob = async () => {
    const [job] = ctx.jobs.list(handle.agent);
    assert.ok(job, 'The dispatch is owned by the actual DSH Jobs provider.');
    return ctx.jobs.wait(job.id, 10000, handle.agent);
  };
  return { root, ctx, store, enterprise, runtime, services, adapter, handle, send, read, seed, waitJob, definitions, remove, identity };
}

test('authenticated occurrence approval dispatches through real Jobs, AgentLoop and durable JSONL exactly once', async t => {
  const h = await fixture(t); const instance = h.seed();
  h.runtime.tick(); assert.equal(h.ctx.jobs.list(h.handle.agent).length, 0);
  assert.equal((await h.send({ type: 'approve', id: 'plan', instanceId: instance.id })).status, 200);
  h.runtime.tick(); assert.equal((await h.waitJob()).status, 'completed');
  await h.handle.agent.whenIdle(); await h.ctx.sessions.flush(h.handle.agent.session);
  assert.equal(h.store.instance(instance.id).state, 'dispatched');
  assert.equal(h.adapter.requests.length, 1);
  const persisted = await h.ctx.sessionPersistence.open(h.handle.agent.id, 'read');
  try { assert.match(JSON.stringify((await persisted.read()).events), new RegExp(instance.id)); }
  finally { await persisted.close(); }
  h.runtime.tick(); await h.handle.agent.whenIdle();
  assert.equal(h.adapter.requests.length, 1);
  const status = await (await h.read('?id=plan')).json();
  assert.equal(status.records[0].state, 'dispatched');
  assert.equal(status.workers[0].stale, false);
  assert.equal(h.enterprise.tasks.list(human).tasks.length, 0, 'Dispatch does not fabricate accepted business tasks.');
});

test('missing real DSH approval answerer rejects a tool grant without changing the occurrence', async t => {
  const h = await fixture(t); const instance = h.seed();
  const session = h.handle.agent.session;
  session.append('turn/start', { turn: 1 });
  const definition = h.definitions.get('watchdog_schedule_command');
  const execution = { agent: h.handle.agent, callId: 'approval-call', name: definition.name, signal: new AbortController().signal };
  await assert.rejects(definition.execute({ request: JSON.stringify({ commandId: 'one-grant', command: { type: 'approve', id: 'plan', instanceId: instance.id } }) }, execution), { code: 'permission_denied' });
  assert.equal(h.store.instance(instance.id).state, 'waiting_approval');
  assert.ok(session.snapshotEvents().some(event => event.type === 'approval/decided' && event.data.outcome === 'unavailable'));
  const history = h.enterprise.responsibility().records;
  assert.equal(history.at(-1).outcome, 'denied');
  h.runtime.tick(); assert.equal(h.ctx.jobs.list(h.handle.agent).length, 0);
});

test('keyless scheduled model input matches the owner-local recorded output', async t => {
  const h = await fixture(t);
  const now = Date.now();
  h.store.command(human, scheduleCommandSchema.parse({ commandId: 'snapshot-create', command: { type: 'create', id: 'snapshot-plan', sessionId: 'session',
    prompt: 'Inspect selected customer records. Do not make changes.', rule: { kind: 'at', at: '2026-01-01T00:05:00Z' }, missed: 'coalesce', catchUpLimit: 1 } }), Date.parse('2026-01-01T00:00:00Z'));
  h.store.materialize(now);
  const instance = h.store.query(human, now, 'snapshot-plan').records[0];
  await h.send({ type: 'approve', id: 'snapshot-plan', instanceId: instance.id });
  h.runtime.tick(); await h.waitJob(); await h.handle.agent.whenIdle();
  const request = h.adapter.requests[0];
  const scheduled = request.messages.filter(message => message.role === 'user').flatMap(message => message.content)
    .filter(block => block.type === 'text' && block.text.startsWith('WatchDog scheduled occurrence '));
  assert.equal(scheduled.length, 1);
  const input = scheduled[0].text;
  const expected = JSON.parse(await readFile(new URL('./fixtures/watchdog-schedule.expected.json', import.meta.url), 'utf8'));
  assert.deepEqual({ input, dispatchState: h.store.instance(instance.id).state, modelResponses: h.adapter.requests.length }, expected);
});

function enterpriseAccess() {
  const members = new Map([['owner', { active: true, roles: ['executor'], resources: ['plan'], policyVersion: 1 }], ['approver', { active: true, roles: ['approver'], resources: ['plan'], policyVersion: 1 }], ['delegate', { active: true, roles: ['executor'], resources: ['plan'], policyVersion: 1 }]]);
  let grants = 1;
  const authority = {
    http: async () => ({ organizationId: 'company', memberId: 'owner', actor: 'human' }),
    agent: async sessionId => ({ organizationId: 'company', memberId: 'owner', actor: 'agent', sessionId, delegatorId: 'delegate' }),
    membership: async (_org, id) => members.get(id),
    consumeApproval: async () => grants-- > 0 ? { id: 'approved-once', approverId: 'approver' } : undefined,
  };
  const access = new GovernanceAccess({ mode: 'enterprise', organizationId: 'company', authority });
  const identity = { ...human, actor: { kind: 'member', id: 'owner' }, principalId: 'owner', organizationId: 'company' };
  return { access, identity, members, authority };
}

test('dispatch rechecks resource ownership and revoked delegators after approval and refuses foreign HTTP callers', async t => {
  const auth = enterpriseAccess(); const h = await fixture(t, auth.access, auth.identity); const instance = h.seed();
  assert.equal((await h.send({ type: 'approve', id: 'plan', instanceId: instance.id })).status, 200);
  auth.members.set('delegate', { active: false, roles: ['executor'], resources: ['plan'], policyVersion: 2 });
  h.runtime.tick(); assert.equal((await h.waitJob()).status, 'failed');
  assert.equal(h.store.instance(instance.id).state, 'failed'); assert.equal(h.adapter.requests.length, 0);
  auth.authority.http = async () => ({ organizationId: 'other-company', memberId: 'owner', actor: 'human' });
  assert.equal((await h.read('?id=plan')).status, 403);
  auth.authority.http = async () => { throw new Error('Authority unavailable'); };
  assert.equal((await h.read('?id=plan')).status, 503);
});

test('permission revocation while persistence is pending fences the final enqueue', async t => {
  const auth = enterpriseAccess(); const h = await fixture(t, auth.access, auth.identity); const instance = h.seed();
  await h.send({ type: 'approve', id: 'plan', instanceId: instance.id });
  const arrived = Promise.withResolvers(); const released = Promise.withResolvers();
  h.services.sessions = { flush: async () => { arrived.resolve(); await released.promise; return true; } };
  h.runtime.tick(); await arrived.promise;
  auth.members.set('owner', { active: false, roles: ['executor'], resources: ['plan'], policyVersion: 2 });
  released.resolve(); await h.waitJob();
  assert.equal(h.store.instance(instance.id).state, 'failed'); assert.equal(h.adapter.requests.length, 0);
});

test('durability failure after enqueue is uncertain and is never automatically retried', async t => {
  const h = await fixture(t); const instance = h.seed(); await h.send({ type: 'approve', id: 'plan', instanceId: instance.id });
  let flushes = 0;
  h.services.sessions = { flush: async session => ++flushes === 1 ? h.ctx.sessions.flush(session) : false };
  h.runtime.tick(); await h.waitJob(); await h.handle.agent.whenIdle();
  assert.equal(h.store.instance(instance.id).state, 'uncertain'); assert.equal(h.adapter.requests.length, 1);
  h.runtime.tick(); await h.handle.agent.whenIdle(); assert.equal(h.adapter.requests.length, 1);
  assert.equal((await h.send({ type: 'resolve-uncertain', id: 'plan', instanceId: instance.id, resolution: 'acknowledge-dispatched', reason: 'The Session contains the instance id and the resulting review.' })).status, 200);
  const history = await (await h.read('?id=plan&history=true')).json();
  assert.equal(history.records.at(-1).action, 'resolve-uncertain');
});

test('consumer unload cancels an in-flight admission without waking the agent', async t => {
  const h = await fixture(t); const instance = h.seed(); await h.send({ type: 'approve', id: 'plan', instanceId: instance.id });
  const arrived = Promise.withResolvers(); const released = Promise.withResolvers();
  h.services.sessions = { flush: async () => { arrived.resolve(); await released.promise; return true; } };
  h.runtime.tick(); await arrived.promise;
  await h.runtime.dispose();
  released.resolve(); await h.waitJob();
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.store.instance(instance.id).state, 'ready');
});

test('HTTP and complete DSH string output enforce distinct UTF-8 budgets including Chinese and escaping', async t => {
  const h = await fixture(t, new GovernanceAccess(), human, { maxQueryBytes: 1800 });
  const command = { type: 'create', id: 'escaped', sessionId: 'session', prompt: '汉字"\\\n'.repeat(40), rule: { kind: 'every', everySeconds: 300 }, missed: 'coalesce', catchUpLimit: 1 };
  assert.equal((await h.send(command)).status, 200);
  const http = await h.read();
  assert.equal(http.status, 200);
  const value = await http.json();
  assert.ok(scheduleResponseBytes(value, 'http') <= 1800);
  const string = JSON.stringify(value);
  assert.equal(scheduleResponseBytes(value, 'tool'), Buffer.byteLength(JSON.stringify({ isError: false, value: string, content: [{ type: 'text', text: string }] })));
  assert.ok(scheduleResponseBytes(value, 'tool') > 1800);
  const execution = { agent: h.handle.agent, callId: 'budget-call', name: 'watchdog_schedule_query', signal: new AbortController().signal };
  await assert.rejects(h.definitions.get(execution.name).execute({}, execution), { code: 'response_too_large' });
  const rejected = await h.ctx.tools.execute({ ...execution, arguments: {} });
  assert.equal(rejected.isError, true);
  const accepted = await h.ctx.tools.execute({ ...execution, callId: 'bounded-query', arguments: { id: 'escaped' } });
  assert.equal(accepted.isError, false);
  assert.equal(Buffer.byteLength(JSON.stringify(accepted)), scheduleResponseBytes(JSON.parse(accepted.value), 'tool'));
  assert.ok(Buffer.byteLength(JSON.stringify(accepted)) <= 1800);
  const request = scheduleCommandSchema.parse({ commandId: 'too-large-tool', command: { ...command, id: 'tool-plan' } });
  assert.throws(() => h.store.command(human, request, Date.now(), 'tool'), { code: 'response_too_large' });
  assert.throws(() => h.store.plan('tool-plan'), { code: 'not_found' }, 'A response overflow rolls the mutation and receipt back.');
  assert.equal(h.store.history(human, 'tool-plan').records.length, 0);
});

test('plan creation rechecks the human after asynchronous Session binding and rejects query typos', async t => {
  const auth = enterpriseAccess(); const h = await fixture(t, auth.access, auth.identity);
  for (const query of ['?offset=1', '?id=plan&id=other', '?history=maybe', '?limit=3&limit=4']) assert.equal((await h.read(query)).status, 400);
  const arrived = Promise.withResolvers(); const released = Promise.withResolvers();
  let ownerReads = 0;
  auth.authority.membership = async (_org, id) => {
    const snapshot = auth.members.get(id);
    if (id === 'owner' && ++ownerReads === 2) { arrived.resolve(); await released.promise; }
    return snapshot;
  };
  const pending = h.send({ type: 'create', id: 'plan', sessionId: 'session', prompt: 'Review', rule: { kind: 'every', everySeconds: 300 }, missed: 'skip', catchUpLimit: 1 });
  await arrived.promise;
  auth.members.set('owner', { active: false, roles: ['executor'], resources: ['plan'], policyVersion: 2 });
  released.resolve();
  assert.equal((await pending).status, 403);
  assert.throws(() => h.store.plan('plan'), { code: 'not_found' });
});
