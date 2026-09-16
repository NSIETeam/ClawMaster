/** Human scheduling actions through the rendered panel, registered Host and real SQLite ledger. */
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ScheduleBoard } from '../src/ScheduleBoard.tsx';
import { WatchdogScheduleClient } from '../src/watchdog-schedule-client.ts';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { openWatchdogScheduleStore } from '../src/watchdog-schedule-store.ts';
import { mountWatchdogSchedules } from '../src/watchdog-schedule-host.ts';
import { GovernanceAccess } from '../src/governance-access.ts';
import { LOCAL_HTTP_IDENTITY as human } from '../src/governance-audit.ts';
import { scheduleCommandSchema } from '../src/watchdog-schedule-format.ts';

const disposals = [];
afterEach(async () => { cleanup(); for (const dispose of disposals.splice(0).reverse()) await dispose(); });
const create = (id = randomUUID()) => ({ type: 'create', id, sessionId: 'session', prompt: 'Inspect selected follow-up records',
  rule: { kind: 'every', everySeconds: 300 }, missed: 'coalesce', catchUpLimit: 1 });

async function fixture({ locale = 'en-US', intercept = async (_input, _init, next) => next() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'schedule-panel-'));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'schedules.sqlite');
  const store = await openWatchdogScheduleStore(path, human.organizationId);
  const enterprise = await openEnterpriseStore(join(root, 'enterprise.sqlite'));
  disposals.push(() => { store.close(); enterprise.close(); });
  const routes = new Map();
  disposals.push(await mountWatchdogSchedules({
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => routes.delete(route.path); } } },
    tools: { register() { return () => {}; } }, approval: { request: async () => 'allowed-once' },
  }, store, enterprise, new GovernanceAccess()));
  const raw = async (input, init) => {
    const url = new URL(input, 'http://fixture');
    return routes.get(url.pathname)(new Request(url, init));
  };
  const client = new WatchdogScheduleClient((input, init) => intercept(input, init, () => raw(input, init)), randomUUID);
  disposals.push(() => client.dispose());
  const opened = [];
  const renderPanel = () => render(createElement(ScheduleBoard, { client, locale,
    sessions: [{ id: 'session', title: 'Follow-up review', running: false, status: 'idle', updatedAt: 0, attention: false }],
    onOpenSession: id => opened.push(id) }));
  const view = renderPanel();
  await waitFor(() => expect(client.getSnapshot().loading).toBe(false));
  const seed = () => {
    const now = Date.now(); const command = create();
    store.command(human, scheduleCommandSchema.parse({ commandId: randomUUID(), command }), now - 300000);
    store.materialize(now);
    return { plan: store.plan(command.id), instance: store.query(human, now, command.id).records[0], now };
  };
  return { client, store, path, opened, view, renderPanel, seed, raw };
}
function fill(label, value) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }

it('creates a plan, approves exactly one occurrence and stops future work without cancelling that occurrence', async () => {
  const { client, store, opened, path } = await fixture();
  fireEvent.click(screen.getByRole('button', { name: 'Create check plan' }));
  fill('Check goal and scope', 'Inspect selected follow-up records'); fill('Execution session', 'session');
  fill('Interval (minutes, at least 5)', '5');
  fireEvent.submit(screen.getByRole('form', { name: 'Create check plan' }));
  await waitFor(() => expect(client.getSnapshot().selected).not.toBeNull());
  const plan = client.getSnapshot().selected;
  expect(store.query(human, Date.now(), plan.id).records).toEqual([]);
  store.materialize(plan.nextAt);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan occurrences' }));
  await waitFor(() => expect(screen.getByText('Waiting for this approval')).toBeTruthy());
  const id = client.getSnapshot().instances[0].id;
  expect(store.instance(id).state).toBe('waiting_approval');
  fireEvent.click(screen.getByRole('button', { name: 'Approve this delivery' }));
  await waitFor(() => expect(screen.getByText('Approved, waiting for delivery')).toBeTruthy());
  expect(screen.queryByText('Request delivered')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open execution session' }));
  expect(opened).toEqual(['session']);
  const detail = screen.getByRole('region', { name: 'Occurrences for this plan' });
  fireEvent.change(within(detail).getAllByLabelText('Action reason')[0], { target: { value: 'Stop future checks for review' } });
  fireEvent.click(screen.getByRole('button', { name: 'Stop future checks' }));
  await waitFor(() => expect(client.getSnapshot().selected.active).toBe(false));
  expect(screen.getByText('Next due: No next due time')).toBeTruthy();
  expect(store.instance(id).state).toBe('ready');
  const reopened = await openWatchdogScheduleStore(path, human.organizationId);
  try { expect(reopened.plan(plan.id).active).toBe(false); expect(reopened.instance(id).state).toBe('ready'); }
  finally { reopened.close(); }
  fireEvent.click(screen.getByText('Schedule action history'));
  fireEvent.click(screen.getByRole('button', { name: 'Read schedule history' }));
  await waitFor(() => expect(client.getSnapshot().history.some(row => row.action === 'cancel-plan')).toBe(true));
  expect(screen.getByText('Plan created')).toBeTruthy();
  expect(screen.getByText('Future checks stopped')).toBeTruthy();
  expect(screen.getByText('cancel-plan').closest('details').open).toBe(false);
});

it('requires session inspection before human resolution and never reenqueues an uncertain occurrence', async () => {
  const { client, store, seed } = await fixture({ locale: 'zh-CN' });
  const { plan, instance, now } = seed();
  store.command(human, scheduleCommandSchema.parse({ commandId: randomUUID(), command: { type: 'approve', id: plan.id, instanceId: instance.id } }), now);
  const lease = store.claim('lost-worker', now); expect(store.beginDispatch(lease, now)).toBe(true);
  store.heartbeat('observer', now + store.config.leaseMs + 1);
  await act(() => client.select(plan));
  expect(screen.getByText('投递结果待核实')).toBeTruthy();
  const confirm = screen.getByRole('button', { name: '确认已投递' });
  expect(confirm.disabled).toBe(true);
  const record = screen.getByText('投递结果待核实').closest('article');
  fireEvent.change(within(record).getByLabelText('操作理由'), { target: { value: '已核对原会话中唯一的巡检编号' } });
  expect(confirm.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('已在原会话核对本次巡检编号与投递记录'));
  fireEvent.click(confirm);
  await waitFor(() => expect(client.getSnapshot().instances[0].state).toBe('dispatched'));
  expect(store.instance(instance.id).attempts).toBe(1);
  expect(store.claim('new-worker', now + store.config.leaseMs + 2)).toBeUndefined();
  expect(screen.queryByText('验收通过')).toBeNull();
  fireEvent.click(screen.getByText('调度操作历史'));
  fireEvent.click(screen.getByRole('button', { name: '读取调度历史' }));
  await waitFor(() => expect(screen.getByText('已人工核实投递结果')).toBeTruthy());
  expect(screen.getByText('resolve-uncertain').closest('details').open).toBe(false);
});

it('keeps the same pending command across navigation after response loss and accepts an older saved receipt', async () => {
  const sent = []; let lose = true;
  const h = await fixture({ intercept: async (_input, init, next) => {
    const response = await next();
    if (init?.method === 'POST') { sent.push(init.body); if (lose) { lose = false; throw new Error('Response lost after commit'); } }
    return response;
  } });
  const command = create();
  await act(async () => { expect(await h.client.command(command)).toBe(false); });
  expect(h.client.getSnapshot().pending).toBe(true);
  expect(h.store.plan(command.id).active).toBe(true);
  const db = new DatabaseSync(h.path);
  const stored = db.prepare('SELECT id,result FROM schedule_commands').get();
  const oldResult = JSON.parse(stored.result); delete oldResult.commandId;
  db.prepare('UPDATE schedule_commands SET result=? WHERE id=?').run(JSON.stringify(oldResult), stored.id); db.close();
  h.view.unmount(); h.renderPanel();
  await waitFor(() => expect(h.client.getSnapshot().loading).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Retry original schedule request' }));
  await waitFor(() => expect(h.client.getSnapshot().saved).toBe(true));
  expect(sent).toHaveLength(2); expect(sent[1]).toBe(sent[0]);
  expect(h.store.history(human, command.id).records.filter(row => row.action === 'create')).toHaveLength(1);
});

it('does not treat another command receipt or invalid response as success or unlock an uncertain write', async () => {
  let corrupt = true;
  const h = await fixture({ intercept: async (_input, init, next) => {
    const response = await next();
    if (init?.method === 'POST' && corrupt) return Response.json({ ...await response.json(), commandId: 'unrelated-command' });
    return response;
  } });
  const command = create();
  await act(async () => { expect(await h.client.command(command)).toBe(false); });
  expect(h.client.getSnapshot().pending).toBe(true); expect(h.client.getSnapshot().saved).toBe(false);
  await act(async () => { expect(await h.client.command(create())).toBe(false); });
  corrupt = false;
  await act(async () => { expect(await h.client.retry()).toBe(true); });
  expect(h.store.query(human, Date.now()).records).toHaveLength(1);
});

it('ignores a stale read after a command and allows correction after an explicit state refusal', async () => {
  let block = false; const arrived = Promise.withResolvers(); const released = Promise.withResolvers();
  const h = await fixture({ intercept: async (_input, init, next) => {
    const response = await next();
    if (block && init?.method !== 'POST') { arrived.resolve(); await released.promise; }
    return response;
  } });
  block = true;
  let reading;
  act(() => { reading = h.client.refresh(); });
  await arrived.promise;
  await act(async () => { expect(await h.client.command(create('new-plan'))).toBe(true); });
  await act(async () => { released.resolve(); await reading; });
  expect(h.client.getSnapshot().plans.map(plan => plan.id)).toEqual(['new-plan']);
  await act(async () => { expect(await h.client.command(create('new-plan'))).toBe(false); });
  expect(h.client.getSnapshot().pending).toBe(false); expect(h.client.getSnapshot().error).toBe('conflict');
  await act(async () => { expect(await h.client.command({ type: 'cancel-plan', id: 'new-plan', reason: 'Resolved duplicate plan' })).toBe(true); });
  expect(h.client.getSnapshot().selected.active).toBe(false);
});

it('allows correction of a past or invalid zoned time without keeping an uncommitted command locked', async () => {
  const h = await fixture();
  for (const at of ['2000-01-01T00:00:00Z', { date: '2027-01-01', time: '09:00', time_zone: 'Invalid/Zone' }]) {
    await act(async () => { expect(await h.client.command({ ...create(), rule: { kind: 'at', at } })).toBe(false); });
    expect(h.client.getSnapshot().pending).toBe(false);
    expect(h.client.getSnapshot().error).toBe('invalid');
    expect(h.store.query(human, Date.now()).records).toHaveLength(0);
  }
  await act(async () => { expect(await h.client.command(create())).toBe(true); });
});

it('pages complete worker observations without replacing the selected occurrence list', async () => {
  const h = await fixture(); const { plan, now } = h.seed();
  for (let i = 0; i < 125; i++) h.store.heartbeat(`worker-${i}`, now, i < 100 ? 'worker_stopped' : null);
  await act(() => h.client.select(plan));
  expect(h.client.getSnapshot().workerSummary).toMatchObject({ total: 125, online: 25, stopped: 100 });
  const original = h.client.getSnapshot().instances;
  expect(h.client.getSnapshot().workers).toHaveLength(100);
  fireEvent.click(screen.getByText('Inspect scheduler workers'));
  fireEvent.click(screen.getByRole('button', { name: 'Next worker page' }));
  await waitFor(() => expect(h.client.getSnapshot().workers).toHaveLength(25));
  expect(h.client.getSnapshot().workerSummary.nextAfter).toBeNull();
  expect(h.client.getSnapshot().instances).toBe(original);
});
