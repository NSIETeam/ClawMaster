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
import { mountWatchdogTasks } from '../src/watchdog-task-host.ts';

const disposals = [];
afterEach(async () => { cleanup(); for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture(locale = 'en-US') {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-ui-'));
  const path = join(root, 'enterprise.sqlite');
  disposals.push(() => rm(root, { force: true, recursive: true }));
  const store = await openEnterpriseStore(path);
  disposals.push(() => store.close());
  const routes = new Map();
  const remove = await mountWatchdogTasks({
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } },
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
    onOpenSession: id => opened.push(id) }));
  await waitFor(() => expect(client.getSnapshot().loading).toBe(false));
  return { client, store, path, opened, view };
}
function fill(label, value) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
async function status(client, value) { await waitFor(() => expect(client.getSnapshot().selected?.status).toBe(value)); }

it('creates, links, submits, rejects, resubmits and accepts a durable task without treating idle as success', async () => {
  const { client, store, path, opened } = await fixture();
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
  fireEvent.click(screen.getByRole('button', { name: 'Record execution start' }));
  await status(client, 'in_progress');
  expect(screen.getByText('Session idle')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Open execution session/ }));
  expect(opened).toEqual(['follow-up-session']);
  const submit = async summary => {
    fill('Evidence location', 'https://example.invalid/follow-up-report');
    fill('Evidence summary', summary);
    fill('Evidence observed at', '2026-09-16T10:00');
    fireEvent.click(screen.getByLabelText('Inspect the follow-up report'));
    fireEvent.submit(screen.getByRole('form', { name: 'Submit results for review' }));
    await status(client, 'awaiting_review');
  };
  await submit('Initial risk report');
  expect(screen.getByText(/Evidence has not been verified/)).toBeTruthy();
  fill('Review comment or action reason', 'Include the response from the customer');
  fireEvent.click(screen.getByRole('button', { name: 'Request rework' }));
  await status(client, 'ready');
  fill('Execution session', 'follow-up-session');
  fireEvent.click(screen.getByRole('button', { name: 'Record execution start' }));
  await status(client, 'in_progress');
  await submit('Updated report with customer response');
  fill('Review comment or action reason', 'Reviewed the report and response');
  fireEvent.click(screen.getByRole('button', { name: 'Accept result' }));
  await status(client, 'accepted');
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
