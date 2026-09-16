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
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { Session, SessionId } from '@deepseek-ai/dsh-session';

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
  apply({ type: 'start', sessionId: 'idle-session' }, agent);
  const evidence = [{ id: 'report-1', location: 'file:///review.md', observedAt: '2026-09-16T00:00:00.000Z', summary: 'Customer risk evidence' }];
  const submitted = apply({ type: 'submit', evidence, completedCriteria: ['follow-up'] }, agent);
  assert.throws(() => apply({ type: 'review', decision: 'accept', comment: 'Agent self review' }, agent), { code: 'permission_denied' });
  assert.throws(() => apply({ type: 'review', decision: 'accept', comment: 'Old review' }, LOCAL_HTTP_IDENTITY, { revision: 1 }), { code: 'revision_conflict' });
  apply({ type: 'review', decision: 'reject', comment: 'Need updated evidence' });
  apply({ type: 'start', sessionId: 'idle-session' }, agent);
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
      apply(2, { type: 'start', sessionId: 'same-idle-session' });
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
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, approval: { request: async () => 'allowed-once' } };
  const remove = await mountWatchdogTasks(ctx, store, new GovernanceAccess());
  t.after(remove);
  const request = { id: 'task-1', revision: 0, commandId: 'create', command: { type: 'create', task: definition } };
  const send = body => routes.get('/api/clawmaster/tasks/command')(new Request('http://fixture/tasks/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await send({ ...request, actor: { kind: 'member', id: 'admin' } })).status, 400);
  assert.equal((await send(request)).status, 200);
  const exec = { agent: { id: 'agent-1' }, callId: 'call-1', name: 'watchdog_task_command', signal: new AbortController().signal };
  await assert.rejects(tools.get('watchdog_task_command').execute({ id: 'task-1', revision: 1, commandId: 'fake-review', command: { type: 'review', decision: 'accept', comment: 'Forged' } }, exec), { code: 'permission_denied' });
  await remove();
  assert.equal(routes.size, 0); assert.equal(tools.size, 0);
});

test('task scope refuses another organization and a submitting member cannot approve through their agent', async t => {
  const { store } = await fixture(t);
  const member = { ...LOCAL_HTTP_IDENTITY, organizationId: 'org-one', actor: { kind: 'member', id: 'alice' } };
  const delegated = { ...member, actor: { kind: 'agent', id: 'delegated-session' }, principalId: 'alice', source: 'tool' };
  const apply = (revision, command, identity = member) => store.tasks.execute(identity, { id: 'org-task', revision, commandId: randomUUID(), command });
  apply(0, { type: 'create', task: { ...definition, owner: { kind: 'member', id: 'alice' } } });
  apply(1, { type: 'queue' });
  apply(2, { type: 'start', sessionId: 'delegated-session' }, delegated);
  apply(3, { type: 'submit', evidence: [{ id: 'ev', location: 'file:///result.txt', observedAt: '2026-09-16T00:00:00.000Z', summary: 'Result' }], completedCriteria: ['follow-up'] }, delegated);
  assert.throws(() => apply(4, { type: 'review', decision: 'accept', comment: 'Self acceptance' }), { code: 'permission_denied' });
  assert.throws(() => store.tasks.get({ ...member, organizationId: 'org-two' }, 'org-task'), { code: 'not_found' });
  assert.equal(store.tasks.list({ ...member, organizationId: 'org-two' }).tasks.length, 0);
});

test('task tools execute through the real DSH schema, approval and output pipeline', async t => {
  const { store } = await fixture(t);
  const ctx = new Context();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const remove = await mountWatchdogTasks({ tools: ctx.tools, approval: ctx.approval,
    connection: { fetch: { register() { return async () => {}; } } } }, store, new GovernanceAccess());
  t.after(async () => { await remove(); await ctx.fiber.dispose(); });
  ctx.on('approval/request', async () => 'allowed-once');
  const session = Session.create(SessionId(randomUUID())); session.append('turn/start', { turn: 1 });
  const execute = (name, args) => ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent: { id: session.id, session }, signal: new AbortController().signal });
  const created = await execute('watchdog_task_command', { id: 'model-task', revision: 0, commandId: 'create', command: { type: 'create', task: definition } });
  assert.equal(created.isError, false, JSON.stringify(created));
  assert.equal(created.value.status, 'draft');
  const query = await execute('watchdog_task_query', { id: 'model-task' });
  assert.equal(query.isError, false, JSON.stringify(query));
  assert.equal(query.value.owner.label, 'Local manager');
  const list = await execute('watchdog_task_query', {});
  assert.equal(list.isError, false, JSON.stringify(list));
  assert.equal(list.value.tasks.length, 1);
});
