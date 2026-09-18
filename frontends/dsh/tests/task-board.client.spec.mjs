/** Business acceptance through rendered forms, registered Host routes and durable storage. */
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskBoard } from '../src/TaskBoard.tsx';
import { WatchdogTaskClient } from '../src/watchdog-task-client.ts';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { GovernanceAccess } from '../src/governance-access.ts';
import { LOCAL_HTTP_IDENTITY } from '../src/governance-audit.ts';
import { mountWatchdogTasks as mountWatchdogTasksImpl } from '../src/watchdog-task-host.ts';
import { watchdogTaskTestContext } from './watchdog-task-test-context.mjs';

const mountWatchdogTasks = (context, ...args) => mountWatchdogTasksImpl(watchdogTaskTestContext(context), ...args);
import { prepareTaskExecution } from '../src/task-execution.ts';
import { retryTaskExecution } from '../src/task-execution.ts';

const disposals = [];
afterEach(async () => { cleanup(); for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture(locale = 'en-US', onRunExecution = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-ui-'));
  const path = join(root, 'enterprise.sqlite');
  disposals.push(() => rm(root, { force: true, recursive: true }));
  const store = await openEnterpriseStore(path);
  disposals.push(() => store.close());
  const routes = new Map();
  const remove = await mountWatchdogTasks({
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
    sessions: { get: id => String(id) === 'follow-up-session' ? { id } : undefined },
    tools: { register() { return () => {}; } }, approval: { request: async () => 'allowed-once' },
  }, store, new GovernanceAccess());
  disposals.push(remove);
  const client = new WatchdogTaskClient(async (input, init) => {
    const url = new URL(input, 'http://fixture');
    return routes.get(url.pathname)(new Request(url, init));
  }, randomUUID);
  disposals.push(() => client.dispose());
  const opened = [];
  const view = render(createElement(TaskBoard, { client, locale,
    sessions: [{ id: 'follow-up-session', title: 'Customer follow-up check', running: false, status: 'idle', updatedAt: 0, attention: false }],
    onOpenSession: id => opened.push(id), onPrepareExecution: () => randomUUID(), onAbandonExecution() {}, onRunExecution }));
  await waitFor(() => expect(client.getSnapshot().loading).toBe(false));
  return { client, store, path, opened, view };
}
function fill(label, value) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
async function status(client, value) { await waitFor(() => expect(client.getSnapshot().selected?.status).toBe(value)); }

it('creates, links, submits, rejects, resubmits and accepts a durable task without treating idle as success', async () => {
  const submitted = [];
  const { client, store, path, opened } = await fixture('en-US', async task => submitted.push(task));
  fireEvent.click(screen.getByRole('button', { name: 'Create business task' }));
  fill('Business goal', 'Customer follow-up risk');
  fill('Scope and source material', 'Review selected follow-up records');
  fill('Owner', 'Follow-up manager');
  fill('Deadline', '2027-01-01T09:00');
  fill('Acceptance criteria (one per line)', 'Inspect the follow-up report');
  fireEvent.submit(screen.getByRole('form', { name: 'Create business task' }));
  await status(client, 'draft');
  const id = client.getSnapshot().selected.id;
  fireEvent.click(screen.getByRole('button', { name: 'Queue for execution' }));
  await status(client, 'ready');
  fill('Execution session', 'follow-up-session');
  fireEvent.click(screen.getByRole('button', { name: 'Start and submit task goal' }));
  await status(client, 'in_progress');
  await waitFor(() => expect(submitted.length).toBe(1));
  expect(submitted[0].goal).toBe('Customer follow-up risk');
  expect(submitted[0].scope).toBe('Review selected follow-up records');
  expect(submitted[0].checklist[0].description).toBe('Inspect the follow-up report');
  expect(submitted[0].execution).toEqual({ sessionId: 'follow-up-session', requestId: expect.any(String), locale: 'en-US' });
  expect(screen.getByText('Session idle')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Open execution session/ }));
  expect(opened).toEqual(['follow-up-session']);
  const submit = async (summary, useLinkedSession = false) => {
    if (useLinkedSession) fill('Reference a linked Session', 'follow-up-session');
    else fill('Evidence location', 'https://example.invalid/follow-up-report');
    fill('Evidence summary', summary);
    fill('Evidence observed at', '2026-09-16T10:00');
    fireEvent.click(screen.getByLabelText('Inspect the follow-up report'));
    fireEvent.submit(screen.getByRole('form', { name: 'Submit results for review' }));
    await status(client, 'awaiting_review');
  };
  await submit('Initial risk report');
  expect(screen.getByText(/could not be checked automatically/)).toBeTruthy();
  fill('Review comment or action reason', 'Include the response from the customer');
  fireEvent.click(screen.getByRole('button', { name: 'Request rework' }));
  await status(client, 'ready');
  fill('Execution session', 'follow-up-session');
  fireEvent.click(screen.getByRole('button', { name: 'Start and submit task goal' }));
  await status(client, 'in_progress');
  await submit('Updated report with customer response', true);
  expect(client.getSnapshot().selected.evidence[0].location).toBe('dsh-session://follow-up-session');
  expect(screen.getByText(/linked DSH Session is accessible/)).toBeTruthy();
  fill('Review comment or action reason', 'Reviewed the report and response');
  fireEvent.click(screen.getByRole('button', { name: 'Accept result' }));
  await status(client, 'accepted');
  const taskCard = screen.getAllByText('Customer follow-up risk')[0].closest('article');
  expect(within(taskCard).getByText('New business task')).toBeTruthy();
  expect(within(taskCard).getByText(/Next step: Review the acceptance record/)).toBeTruthy();
  const persisted = store.tasks.get(LOCAL_HTTP_IDENTITY, id);
  expect(persisted.owner).toEqual({ kind: 'local', label: 'Follow-up manager' });
  expect(persisted.dueAt).not.toBeNull();
  expect(persisted.sessionIds).toEqual(['follow-up-session']);
  fireEvent.click(screen.getByText('Evidence and review history'));
  fireEvent.click(screen.getByRole('button', { name: 'Read task history' }));
  await waitFor(() => expect(client.getSnapshot().history.length).toBe(8));
  const history = client.getSnapshot().history;
  expect(history[3].evidence[0].summary).toBe('Initial risk report');
  expect(history[4].lastReview.comment).toBe('Include the response from the customer');
  const reopened = await openEnterpriseStore(path);
  try { expect(reopened.tasks.get(LOCAL_HTTP_IDENTITY, id)).toEqual(persisted); } finally { reopened.close(); }
  fill('Review comment or action reason', 'Follow-up results changed');
  fireEvent.click(screen.getByRole('button', { name: 'Reopen task' }));
  await status(client, 'ready');
});

it('renders the Chinese management flow and keeps denied commands out of the result state', async () => {
  const { client } = await fixture('zh-CN');
  expect(screen.getByRole('region', { name: '业务任务与验收' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '建立业务任务' }));
  expect(screen.getByLabelText('负责人类型').textContent).toContain('未认证成员');
  fill('业务目标', '本地草稿'); fill('范围与资料', '选定的资料'); fill('负责人', '本地负责人');
  fill('验收标准（每行一项）', '核对证据');
  fireEvent.submit(screen.getByRole('form', { name: '建立业务任务' }));
  await status(client, 'draft');
  await act(() => client.command(client.getSnapshot().selected.id, 1, { type: 'review', decision: 'accept', comment: 'Invalid draft acceptance' }));
  expect(client.getSnapshot().selected.status).toBe('draft');
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: '任务详情' })).queryByRole('button', { name: '验收通过' })).toBeNull();
});

it('retries an uncertain Session start with the persisted request identity and task brief', async () => {
  const attempted = [];
  const { client, store } = await fixture('en-US', async task => {
    attempted.push(task);
    if (attempted.length === 1) throw new Error('Session admission response was lost');
  });
  const definition = { goal: 'Inspect selected orders', scope: 'Only overdue customer orders', owner: { kind: 'local', label: 'Order manager' },
    dueAt: null, timezone: 'UTC', risk: 'high', checklist: [{ id: 'inspect', description: 'List affected orders' }] };
  await act(() => client.command('retry-task', 0, { type: 'create', task: definition }));
  await act(() => client.command('retry-task', 1, { type: 'queue' }));
  fill('Execution session', 'follow-up-session');
  fireEvent.click(screen.getByRole('button', { name: 'Start and submit task goal' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('did not confirm admission'));
  const persisted = store.tasks.get(LOCAL_HTTP_IDENTITY, 'retry-task');
  expect(persisted.execution.sessionId).toBe('follow-up-session');
  expect(attempted[0].goal).toBe(definition.goal);
  fireEvent.click(screen.getByRole('button', { name: 'Retry with original request' }));
  await waitFor(() => expect(attempted.length).toBe(2));
  expect(attempted[1].execution).toEqual(persisted.execution);
  expect(attempted[1].goal).toBe(definition.goal);
  expect(store.tasks.history(LOCAL_HTTP_IDENTITY, 'retry-task').tasks).toHaveLength(3);
});

it('dispatches the started task through the selected DSH Session only after its task link is durable', async () => {
  const calls = [];
  const preparedById = new Map();
  let store;
  const dshSession = {
    beginSubmission(input) {
      calls.push(['beginSubmission', input]);
      return { requestId: 'dsh-task-request', abandon() {} };
    },
    async prompt(content, mode, _signal, requestId) {
      calls.push(['prompt', content, mode, requestId, store.tasks.get(LOCAL_HTTP_IDENTITY, 'dispatch-task').execution]);
      return { ok: true, value: { accepted: true } };
    },
  };
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dispatch-'));
  const db = await openEnterpriseStore(join(root, 'enterprise.sqlite'));
  store = db;
  disposals.push(() => rm(root, { force: true, recursive: true }));
  disposals.push(() => db.close());
  const routes = new Map();
  const remove = await mountWatchdogTasks({
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
    tools: { register() { return () => {}; } }, approval: { request: async () => 'allowed-once' },
  }, db, new GovernanceAccess());
  disposals.push(remove);
  const client = new WatchdogTaskClient(async (input, init) => {
    const url = new URL(input, 'http://fixture');
    return routes.get(url.pathname)(new Request(url, init));
  }, randomUUID);
  disposals.push(() => client.dispose());
  render(createElement(TaskBoard, { client, locale: 'en-US',
    sessions: [{ id: 'follow-up-session', title: 'Customer follow-up check', running: false, status: 'idle', updatedAt: 0, attention: false }],
    onOpenSession() {},
    onPrepareExecution(task) {
      const prepared = prepareTaskExecution(task, 'en-US', dshSession);
      preparedById.set(prepared.requestId, prepared);
      return prepared.requestId;
    },
    onAbandonExecution(id) { preparedById.get(id)?.abandon(); preparedById.delete(id); },
    async onRunExecution(task) {
      const prepared = preparedById.get(task.execution.requestId);
      await prepared.submit(task, 'en-US', record => client.recordExecutionOutcome(record),
        new AbortController().signal);
    },
  }));
  await waitFor(() => expect(client.getSnapshot().loading).toBe(false));
  await act(() => client.command('dispatch-task', 0, { type: 'create', task: {
    goal: 'Review the selected customer follow-up', scope: 'Use only selected follow-up records',
    owner: { kind: 'local', label: 'Follow-up manager' }, dueAt: null, timezone: 'Asia/Shanghai', risk: 'medium',
    checklist: [{ id: 'report', description: 'Return the follow-up report' }],
  } }));
  await act(() => client.command('dispatch-task', 1, { type: 'queue' }));
  fill('Execution session', 'follow-up-session');
  fireEvent.click(screen.getByRole('button', { name: 'Start and submit task goal' }));
  await waitFor(() => expect(calls.some(call => call[0] === 'prompt')).toBe(true));
  expect(calls[0][0]).toBe('beginSubmission');
  expect(calls[0][1]).toMatchObject({ mode: 'queue', attachments: [] });
  expect(calls[0][1].text).toContain('Review the selected customer follow-up');
  expect(calls[1]).toMatchObject({
    0: 'prompt', 1: [{ type: 'text', text: calls[0][1].text }], 2: 'queue', 3: 'dsh-task-request',
    4: { sessionId: 'follow-up-session', requestId: 'dsh-task-request' },
  });
});

it('records only uncertain admission and retries the exact Session request after response loss', async () => {
  const calls = [];
  let prepared;
  let prompts = 0;
  const dshSession = {
    beginSubmission(input) {
      calls.push(['beginSubmission', input]);
      return { requestId: 'durable-task-request', abandon() {} };
    },
    async prompt(content, mode, _signal, requestId) {
      calls.push(['prompt', content, mode, requestId]);
      prompts++;
      if (prompts === 1) throw new Error('Session admission response was lost');
      return { ok: true, value: { accepted: true } };
    },
  };
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dispatch-outcome-'));
  const db = await openEnterpriseStore(join(root, 'enterprise.sqlite'));
  disposals.push(() => rm(root, { force: true, recursive: true }));
  disposals.push(() => db.close());
  const routes = new Map();
  const remove = await mountWatchdogTasks({
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
    tools: { register() { return () => {}; } }, approval: { request: async () => 'allowed-once' },
  }, db, new GovernanceAccess());
  disposals.push(remove);
  const transport = new WatchdogTaskClient(async (input, init) => {
    const url = new URL(input, 'http://fixture');
    return routes.get(url.pathname)(new Request(url, init));
  }, randomUUID);
  disposals.push(() => transport.dispose());
  const auditRequests = [];
  const record = task => { auditRequests.push('uncertain'); return transport.recordExecutionOutcome(task); };
  const view = render(createElement(TaskBoard, { client: transport, locale: 'en-US',
    sessions: [{ id: 'follow-up-session', title: 'Customer follow-up check', running: false, status: 'idle', updatedAt: 0, attention: false }],
    onOpenSession() {},
    onPrepareExecution(task) { prepared = prepareTaskExecution(task, 'en-US', dshSession); return prepared.requestId; },
    onAbandonExecution() {},
    async onRunExecution(task) {
      if (prepared) { const attempt = prepared; prepared = undefined; return attempt.submit(task, 'en-US', record, new AbortController().signal); }
      return retryTaskExecution(task, dshSession, record, new AbortController().signal);
    },
  }));
  await waitFor(() => expect(transport.getSnapshot().loading).toBe(false));
  await act(() => transport.command('outcome-task', 0, { type: 'create', task: {
    goal: 'Review selected customer records', scope: 'Use only selected follow-up records',
    owner: { kind: 'local', label: 'Follow-up manager' }, dueAt: null, timezone: 'Asia/Shanghai', risk: 'medium',
    checklist: [{ id: 'report', description: 'Return the follow-up report' }],
  } }));
  await act(() => transport.command('outcome-task', 1, { type: 'queue' }));
  fill('Execution session', 'follow-up-session');
  fireEvent.click(screen.getByRole('button', { name: 'Start and submit task goal' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('did not confirm admission'));
  const uncertain = db.responsibility({ operation: 'task.dispatch' }).records;
  expect(uncertain.map(row => row.outcome)).toEqual(['uncertain']);
  fireEvent.click(screen.getByRole('button', { name: 'Retry with original request' }));
  await waitFor(() => expect(prompts).toBe(2));
  expect(calls.filter(call => call[0] === 'prompt').map(call => call[3])).toEqual(['durable-task-request', 'durable-task-request']);
  expect(auditRequests).toEqual(['uncertain', 'uncertain']);
  expect(db.responsibility({ operation: 'task.dispatch' }).records.map(row => row.outcome)).toEqual(['uncertain']);
  view.unmount();
  cleanup();
});

it('imports an idle Session as a draft, edits its definition and records explicit waiting without accepting it', async () => {
  const { client } = await fixture();
  fireEvent.click(screen.getByRole('button', { name: 'Create business task' }));
  fill('Business goal', 'Recover historical follow-up');
  fill('Scope and source material', 'Review the original conversation');
  fill('Owner', 'Local owner');
  fill('Acceptance criteria (one per line)', 'Review the evidence');
  fill('Create draft from existing session (optional)', 'follow-up-session');
  fireEvent.submit(screen.getByRole('form', { name: 'Create business task' }));
  await status(client, 'draft');
  expect(client.getSnapshot().selected.source).toBe('imported-session');
  expect(screen.getByText('Session idle')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit task definition' }));
  fill('Owner', 'Corrected owner');
  fireEvent.submit(screen.getByRole('form', { name: 'Edit task definition' }));
  await waitFor(() => expect(client.getSnapshot().selected.revision).toBe(2));
  expect(client.getSnapshot().selected.owner.label).toBe('Corrected owner');
  fireEvent.click(screen.getByRole('button', { name: 'Queue for execution' }));
  await status(client, 'ready');
  fill('Review comment or action reason', 'Awaiting customer response');
  fireEvent.click(screen.getByRole('button', { name: 'Record waiting condition' }));
  await waitFor(() => expect(client.getSnapshot().selected.waitingFor).toBe('Awaiting customer response'));
  expect(client.getSnapshot().selected.status).toBe('ready');
  fireEvent.click(screen.getByRole('button', { name: 'Clear waiting condition' }));
  await waitFor(() => expect(client.getSnapshot().selected.waitingFor).toBeNull());
  expect(client.getSnapshot().selected.status).toBe('ready');
});

it('shows one task page and asks for refresh when a concurrent edit invalidates continuation', async () => {
  const { client, store } = await fixture();
  const task = { goal: 'Paged work', scope: 'Synthetic records', owner: { kind: 'local', label: 'Reviewer' }, dueAt: null,
    timezone: 'UTC', risk: 'low', checklist: [{ id: 'done', description: 'Review evidence' }] };
  for (let index = 0; index < 55; index++) store.tasks.execute(LOCAL_HTTP_IDENTITY, {
    id: `page-${index}`, revision: 0, commandId: `create-page-${index}`, command: { type: 'create', task: { ...task, goal: `Paged work ${index}` } },
  });
  await act(() => client.refresh());
  const first = client.getSnapshot().tasks.map(row => row.id);
  fireEvent.click(screen.getByRole('button', { name: 'Next task page' }));
  await waitFor(() => expect(client.getSnapshot().tasks[0].id).not.toBe(first[0]));
  expect(client.getSnapshot().tasks.every(row => !first.includes(row.id))).toBe(true);
  expect(within(screen.getByLabelText('Loaded tasks')).getAllByRole('article').length).toBeLessThanOrEqual(50);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh business tasks' }));
  await waitFor(() => expect(client.getSnapshot().tasks[0].id).toBe(first[0]));
  store.tasks.execute(LOCAL_HTTP_IDENTITY, { id: first[0], revision: 1, commandId: 'concurrent', command: { type: 'queue' } });
  fireEvent.click(screen.getByRole('button', { name: 'Next task page' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The task list changed'));
  expect(client.getSnapshot().tasks.map(row => row.id)).toEqual(first);
});
