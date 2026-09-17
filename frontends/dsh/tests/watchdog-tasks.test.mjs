import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { LOCAL_HTTP_IDENTITY } from '../src/governance-audit.ts';
import { taskIndicators } from '../src/watchdog-tasks.ts';
import { mountWatchdogTasks } from '../src/watchdog-task-host.ts';
import { GovernanceAccess } from '../src/governance-access.ts';
import { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';

const definition = { goal: 'Customer risk review', scope: 'Selected customers', owner: { kind: 'local', label: 'Local manager' },
  dueAt: '2026-01-01T00:00:00.000Z', timezone: 'Asia/Shanghai', risk: 'medium', checklist: [{ id: 'follow-up', description: 'Document follow-up result' }] };
const agent = { ...LOCAL_HTTP_IDENTITY, actor: { kind: 'agent', id: 'agent-1' }, source: 'tool', sessionId: 'agent-1' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-tasks-'));
  const path = join(root, 'enterprise.sqlite');
  const store = await openEnterpriseStore(path);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  let latest;
  const apply = (command, identity = LOCAL_HTTP_IDENTITY, extra = {}) => {
    latest = store.tasks.execute(identity, { id: 'task-1', revision: latest?.revision ?? 0, commandId: randomUUID(), command, ...extra });
    return latest;
  };
  return { store, path, apply };
}

test('task review rejects agent self-acceptance and stale revisions, preserving rejection and resubmission evidence', async t => {
  const { store, path, apply } = await fixture(t);
  apply({ type: 'create', task: definition, importedSessionId: 'idle-session' });
  assert.equal(store.tasks.get(LOCAL_HTTP_IDENTITY, 'task-1').status, 'draft');
  apply({ type: 'queue' });
  apply({ type: 'start', sessionId: 'idle-session', requestId: 'submit-1' }, agent);
  const evidence = [{ id: 'report-1', location: 'file:///review.md', observedAt: '2026-09-16T00:00:00.000Z', summary: 'Customer risk evidence' }];
  const submitted = apply({ type: 'submit', evidence, completedCriteria: ['follow-up'] }, agent);
  assert.throws(() => apply({ type: 'review', decision: 'accept', comment: 'Agent self review' }, agent), { code: 'permission_denied' });
  assert.throws(() => apply({ type: 'review', decision: 'accept', comment: 'Old review' }, LOCAL_HTTP_IDENTITY, { revision: 1 }), { code: 'revision_conflict' });
  apply({ type: 'review', decision: 'reject', comment: 'Need updated evidence' });
  apply({ type: 'start', sessionId: 'idle-session', requestId: 'submit-2' }, agent);
  apply({ type: 'submit', evidence: [{ ...evidence[0], id: 'report-2', summary: 'Updated result' }], completedCriteria: ['follow-up'] }, agent);
  const request = { id: 'task-1', revision: 7, commandId: 'accept-once', command: { type: 'review', decision: 'accept', comment: 'Evidence inspected' } };
  const accepted = store.tasks.execute(LOCAL_HTTP_IDENTITY, request);
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(store.tasks.execute(LOCAL_HTTP_IDENTITY, request), accepted);
  assert.throws(() => store.tasks.execute(LOCAL_HTTP_IDENTITY, {
    id: 'task-1', revision: accepted.revision, commandId: 'link-accepted',
    command: { type: 'link', sessionId: 'late-session' },
  }), { code: 'invalid_transition' });
  const history = store.tasks.history(LOCAL_HTTP_IDENTITY, 'task-1').tasks;
  assert.equal(history.length, 8);
  assert.deepEqual(history[3].evidence, submitted.evidence);
  assert.equal(history[4].lastReview.comment, 'Need updated evidence');
  const reopened = await openEnterpriseStore(path);
  try { assert.deepEqual(reopened.tasks.get(LOCAL_HTTP_IDENTITY, 'task-1'), accepted); }
  finally { reopened.close(); }
});

test('business status, waiting and overdue are independent of one linked idle Session', async t => {
  const { store } = await fixture(t);
  for (const taskId of ['review', 'failed', 'cancelled']) {
    const apply = (revision, command) => store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: taskId, revision, commandId: randomUUID(), command });
    apply(0, { type: 'create', task: definition, importedSessionId: 'same-idle-session' });
    apply(1, { type: 'queue' });
    if (taskId === 'cancelled') apply(2, { type: 'cancel', reason: 'No longer needed' });
    else if (taskId === 'failed') apply(2, { type: 'fail', reason: 'Customer unavailable' });
    else {
      apply(2, { type: 'start', sessionId: 'same-idle-session', requestId: `submit-${taskId}` });
      apply(3, { type: 'submit', evidence: [{ id: 'ev', location: 'https://example.invalid/unavailable', observedAt: '2026-09-16T00:00:00.000Z', summary: 'Review the location before accepting' }], completedCriteria: ['follow-up'] });
    }
  }
  const tasks = store.tasks.list(LOCAL_HTTP_IDENTITY).tasks;
  assert.deepEqual(new Set(tasks.map(task => task.status)), new Set(['awaiting_review', 'failed', 'cancelled']));
  for (const task of tasks) {
    assert.deepEqual(task.sessionIds, ['same-idle-session']);
    assert.equal(taskIndicators(task, Date.parse('2026-09-16')).overdue, task.status !== 'cancelled');
    assert.equal(taskIndicators(task).waiting, false);
    assert.equal(taskIndicators(task).evidenceAvailability, 'unchecked');
  }
});

test('real registered HTTP and tool paths reject forged actor and agent human-only commands', async t => {
  const { store } = await fixture(t);
  const routes = new Map(); const tools = new Map();
  const ctx = { connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, approval: { request: async () => 'allowed-once' },
    on: () => () => {}, logger: { warn() {} } };
  const remove = await mountWatchdogTasks(ctx, store, new GovernanceAccess());
  t.after(remove);
  const request = { id: 'task-1', revision: 0, commandId: 'create', command: { type: 'create', task: definition } };
  const send = body => routes.get('/api/clawmaster/tasks/command')(new Request('http://fixture/tasks/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await send({ ...request, actor: { kind: 'member', id: 'admin' } })).status, 400);
  assert.equal((await send(request)).status, 200);
  store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: 'task-1', revision: 1, commandId: 'queue-for-dispatch', command: { type: 'queue' } });
  store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: 'task-1', revision: 2, commandId: 'start-for-dispatch',
    command: { type: 'start', sessionId: 'session-1', requestId: 'dispatch-request' } });
  const postOutcome = body => routes.get('/api/clawmaster/tasks/execution-outcome')(new Request('http://fixture/tasks/execution-outcome', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const forgedOutcome = { taskId: 'task-1', requestId: 'dispatch-request', sessionId: 'session-1', outcome: 'uncertain',
    actor: { kind: 'member', id: 'admin' }, identity: { actor: { kind: 'member', id: 'admin' } },
    approval: { kind: 'authority', id: 'forged-approval', approverId: 'admin', generation: 0, revision: 2 } };
  assert.equal((await postOutcome(forgedOutcome)).status, 400);
  assert.equal(store.responsibility({ operation: 'task.dispatch' }).records.length, 0);
  const exec = { agent: { id: 'agent-1' }, callId: 'call-1', name: 'watchdog_task_command', signal: new AbortController().signal };
  await assert.rejects(tools.get('watchdog_task_command').execute({ id: 'task-1', revision: 1, commandId: 'fake-review', command: { type: 'review', decision: 'accept', comment: 'Forged' } }, exec), { code: 'permission_denied' });
  await remove();
  assert.equal(routes.size, 0); assert.equal(tools.size, 0);
});

test('only correlated Host Session turn events can finalize task dispatch responsibility', async t => {
  const { store } = await fixture(t);
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const routes = new Map();
  const observerWarnings = [];
  ctx.logger.warn = message => observerWarnings.push(message);
  ctx.connection = { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } };
  const remove = await mountWatchdogTasks(ctx, store, new GovernanceAccess());
  t.after(async () => { await remove(); await ctx.fiber.dispose(); });
  const sessionId = SessionId('task-execution-observed');
  const session = ctx.sessions.create(sessionId);
  const start = (id, requestId) => {
    let revision = 0;
    const execute = command => store.tasks.execute(LOCAL_HTTP_IDENTITY, { id, revision: revision++, commandId: randomUUID(), command });
    execute({ type: 'create', task: definition });
    execute({ type: 'queue' });
    return execute({ type: 'start', sessionId, requestId });
  };
  const postOutcome = (taskId, requestId) => routes.get('/api/clawmaster/tasks/execution-outcome')(new Request('http://fixture/tasks/execution-outcome', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId, requestId, sessionId, outcome: 'uncertain' }),
  }));
  const turn = (number, requestId, reason) => {
    session.append('turn/start', { turn: number });
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'task brief' }], source: { kind: 'user', rpcId: requestId } }), { surfaceOp: 'append' });
    session.append('turn/end', { turn: number, reason });
  };

  start('completed-task', 'request-completed');
  assert.equal((await postOutcome('completed-task', 'request-completed')).status, 200);
  assert.equal((await routes.get('/api/clawmaster/tasks/execution-outcome')(new Request('http://fixture/tasks/execution-outcome', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'completed-task', requestId: 'request-completed', sessionId, outcome: 'succeeded' }),
  }))).status, 403);
  assert.deepEqual(store.responsibility({ operation: 'task.dispatch' }).records.map(record => record.outcome), ['uncertain']);
  turn(1, 'request-completed', { kind: 'completed' });
  assert.deepEqual(observerWarnings, []);
  assert.deepEqual(store.responsibility({ operation: 'task.dispatch' }).records.map(record => record.outcome), ['uncertain', 'succeeded']);

  start('blocked-task', 'request-blocked');
  assert.equal((await postOutcome('blocked-task', 'request-blocked')).status, 200);
  turn(2, 'request-blocked', { kind: 'blocked' });
  const records = store.responsibility({ operation: 'task.dispatch' }).records;
  assert.deepEqual(records.filter(record => record.entityId === 'blocked-task').map(record => record.outcome), ['uncertain', 'failed']);
  assert.equal(records.at(-1).reasonCode, 'session_turn_blocked');
});

test('a delayed Host outcome remains bound to its historical start after the task starts another request', async t => {
  const { store } = await fixture(t);
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const routes = new Map();
  ctx.connection = { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } };
  const remove = await mountWatchdogTasks(ctx, store, new GovernanceAccess());
  t.after(async () => { await remove(); await ctx.fiber.dispose(); });
  const sessionId = SessionId('task-execution-historical-attempt');
  const session = ctx.sessions.create(sessionId);
  let task;
  const execute = command => {
    task = store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: 'historical-attempt-task', revision: task?.revision ?? 0,
      commandId: randomUUID(), command });
    return task;
  };
  const start = requestId => execute({ type: 'start', sessionId, requestId });
  const postOutcome = requestId => routes.get('/api/clawmaster/tasks/execution-outcome')(new Request('http://fixture/tasks/execution-outcome', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'historical-attempt-task', requestId, sessionId, outcome: 'uncertain' }),
  }));

  execute({ type: 'create', task: definition });
  execute({ type: 'queue' });
  start('request-attempt-a');
  assert.equal((await postOutcome('request-attempt-a')).status, 200);
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Attempt A brief' }],
    source: { kind: 'user', rpcId: 'request-attempt-a' } }), { surfaceOp: 'append' });

  execute({ type: 'fail', reason: 'Attempt A timed out' });
  execute({ type: 'queue' });
  start('request-attempt-b');
  assert.equal((await postOutcome('request-attempt-b')).status, 200);
  session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } });

  const records = store.responsibility({ operation: 'task.dispatch' }).records;
  assert.deepEqual(records.filter(record => record.taskExecution?.requestId === 'request-attempt-a').map(record => record.outcome), ['uncertain', 'failed']);
  assert.equal(records.find(record => record.taskExecution?.requestId === 'request-attempt-a' && record.outcome === 'failed').reasonCode, 'session_turn_blocked');
  assert.deepEqual(records.filter(record => record.taskExecution?.requestId === 'request-attempt-b').map(record => record.outcome), ['uncertain']);
});

test('a synchronous audit failure is reported without interrupting Session event persistence', async t => {
  const { store } = await fixture(t);
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const routes = new Map();
  const warnings = [];
  ctx.logger.warn = message => warnings.push(message);
  ctx.connection = { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } };
  const remove = await mountWatchdogTasks(ctx, store, new GovernanceAccess());
  t.after(async () => { await remove(); await ctx.fiber.dispose(); });
  const sessionId = SessionId('task-execution-audit-failure');
  const session = ctx.sessions.create(sessionId);
  store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: 'audit-failure-task', revision: 0, commandId: 'create', command: { type: 'create', task: definition } });
  store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: 'audit-failure-task', revision: 1, commandId: 'queue', command: { type: 'queue' } });
  store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: 'audit-failure-task', revision: 2, commandId: 'start', command: {
    type: 'start', sessionId, requestId: 'request-audit-failure',
  } });
  const response = await routes.get('/api/clawmaster/tasks/execution-outcome')(new Request('http://fixture/tasks/execution-outcome', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'audit-failure-task', requestId: 'request-audit-failure', sessionId, outcome: 'uncertain' }),
  }));
  assert.equal(response.status, 200);

  store.recordObservedTaskExecutionOutcome = () => { throw new Error('injected audit write failure'); };
  assert.doesNotThrow(() => {
    session.append('turn/start', { turn: 1 });
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'task brief' }], source: {
      kind: 'user', rpcId: 'request-audit-failure',
    } }), { surfaceOp: 'append' });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  });
  assert.equal(session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.turn === 1), true);
  assert.deepEqual(store.responsibility({ operation: 'task.dispatch' }).records.map(record => record.outcome), ['uncertain']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /injected audit write failure/);
});

test('task scope refuses another organization and a submitting member cannot approve through their agent', async t => {
  const { store } = await fixture(t);
  const member = { ...LOCAL_HTTP_IDENTITY, organizationId: 'org-one', actor: { kind: 'member', id: 'alice' } };
  const delegated = { ...member, actor: { kind: 'agent', id: 'delegated-session' }, principalId: 'alice', source: 'tool' };
  const apply = (revision, command, identity = member) => store.tasks.execute(identity, { id: 'org-task', revision, commandId: randomUUID(), command });
  apply(0, { type: 'create', task: { ...definition, owner: { kind: 'member', id: 'alice' } } });
  apply(1, { type: 'queue' });
  apply(2, { type: 'start', sessionId: 'delegated-session', requestId: 'submit-delegated' }, delegated);
  apply(3, { type: 'submit', evidence: [{ id: 'ev', location: 'file:///result.txt', observedAt: '2026-09-16T00:00:00.000Z', summary: 'Result' }], completedCriteria: ['follow-up'] }, delegated);
  assert.throws(() => apply(4, { type: 'review', decision: 'accept', comment: 'Self acceptance' }), { code: 'permission_denied' });
  assert.throws(() => store.tasks.get({ ...member, organizationId: 'org-two' }, 'org-task'), { code: 'not_found' });
  assert.equal(store.tasks.list({ ...member, organizationId: 'org-two' }).tasks.length, 0);
});

test('enterprise task start rejects a target Session owned by another member', async t => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-enterprise-task-owner-'));
  const store = await openEnterpriseStore(join(root, 'enterprise.sqlite'), 5000, 'org-a');
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const memberIdentity = { actor: { kind: 'member', id: 'alice' }, principalId: 'alice', organizationId: 'org-a', source: 'http', policyVersion: 0 };
  store.tasks.execute(memberIdentity, { id: 'owned-task', revision: 0, commandId: 'create-owned',
    command: { type: 'create', task: { ...definition, owner: { kind: 'member', id: 'alice' } } } });
  store.tasks.execute(memberIdentity, { id: 'owned-task', revision: 1, commandId: 'queue-owned', command: { type: 'queue' } });
  let targetChecks = 0;
  const authority = {
    http: async () => ({ organizationId: 'org-a', memberId: 'alice', actor: 'human' }),
    agent: async sessionId => { targetChecks++; return { organizationId: 'org-a', memberId: 'bob', actor: 'agent', sessionId }; },
    membership: async () => ({ active: true, roles: ['administrator'], policyVersion: 1, resources: ['*'] }),
    consumeApproval: async () => ({ id: 'approval-1', approverId: 'approver' }),
  };
  const routes = new Map();
  const ctx = { connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
    tools: { register() { return () => {}; } }, approval: { request: async () => 'allowed-once' },
    on: () => () => {}, logger: { warn() {} } };
  const remove = await mountWatchdogTasks(ctx, store, new GovernanceAccess({ mode: 'enterprise', organizationId: 'org-a', authority }));
  t.after(remove);
  const response = await routes.get('/api/clawmaster/tasks/command')(new Request('http://fixture/tasks/command', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'owned-task', revision: 2, commandId: 'start-foreign',
      command: { type: 'start', sessionId: 'bob-session', requestId: 'foreign-request', locale: 'en-US' } }),
  }));
  assert.equal(response.status, 403);
  assert.ok(targetChecks > 0);
  assert.equal(store.tasks.get(memberIdentity, 'owned-task').status, 'ready');
  assert.deepEqual(store.tasks.get(memberIdentity, 'owned-task').sessionIds, []);
  assert.equal(store.responsibility({ operation: 'task.dispatch' }).records.length, 0);
});

test('task tools execute through the real DSH schema, approval and output pipeline', async t => {
  const { store } = await fixture(t);
  const ctx = new Context();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const remove = await mountWatchdogTasks({ on: ctx.on.bind(ctx), logger: ctx.logger, tools: ctx.tools, approval: ctx.approval,
    connection: { fetch: { register() { return async () => {}; } } } }, store, new GovernanceAccess());
  t.after(async () => { await remove(); await ctx.fiber.dispose(); });
  ctx.on('approval/request', async () => 'allowed-once');
  const session = Session.create(SessionId(randomUUID())); session.append('turn/start', { turn: 1 });
  const execute = (name, args) => ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent: { id: session.id, session }, signal: new AbortController().signal });
  const created = await execute('watchdog_task_command', { id: 'model-task', revision: 0, commandId: 'create', command: { type: 'create', task: definition } });
  assert.equal(created.isError, false, JSON.stringify(created));
  assert.equal(created.value.status, 'draft');
  const responsibility = store.responsibility({ commandId: 'create' }).records[0];
  assert.deepEqual(responsibility.identity.approval, { kind: 'dsh-one-shot' });
  assert.equal('id' in responsibility.identity.approval, false);
  assert.equal('approverId' in responsibility.identity.approval, false);
  const query = await execute('watchdog_task_query', { id: 'model-task' });
  assert.equal(query.isError, false, JSON.stringify(query));
  assert.equal(query.value.owner.label, 'Local manager');
  const list = await execute('watchdog_task_query', {});
  assert.equal(list.isError, false, JSON.stringify(list));
  assert.equal(list.value.tasks.length, 1);
});

test('a denied DSH one-shot approval records no approver identity and commits no task', async t => {
  const { store } = await fixture(t);
  const ctx = new Context();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const remove = await mountWatchdogTasks({ on: ctx.on.bind(ctx), logger: ctx.logger, tools: ctx.tools, approval: ctx.approval,
    connection: { fetch: { register() { return async () => {}; } } } }, store, new GovernanceAccess());
  t.after(async () => { await remove(); await ctx.fiber.dispose(); });
  ctx.on('approval/request', async () => 'denied');
  const session = Session.create(SessionId(randomUUID())); session.append('turn/start', { turn: 1 });
  const result = await ctx.tools.execute({ callId: 'denied-call', name: 'watchdog_task_command', arguments: {
    id: 'denied-task', revision: 0, commandId: 'denied-command', command: { type: 'create', task: definition },
  }, agent: { id: session.id, session }, signal: new AbortController().signal });
  assert.equal(result.isError, true);
  assert.throws(() => store.tasks.get(LOCAL_HTTP_IDENTITY, 'denied-task'), { code: 'not_found' });
  const history = store.responsibility({ commandId: 'denied-command' }).records;
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, 'failed');
  assert.equal(history[0].reasonCode, 'approval_unavailable');
  assert.equal(history[0].identity.approval, undefined);
});
