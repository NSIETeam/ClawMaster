import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { openWatchdogScheduleStore } from '../src/watchdog-schedule-store.ts';
import { scheduleCommandSchema } from '../src/watchdog-schedule-format.ts';
import { LOCAL_HTTP_IDENTITY as human } from '../src/governance-audit.ts';

const config = { pollMs: 100, leaseMs: 1000, heartbeatStaleMs: 1000, retryBaseMs: 100, retryMaxMs: 1000, approvalTimeoutMs: 10000 };
const start = Date.parse('2026-01-01T00:00:00Z');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-schedule-'));
  const path = join(root, 'schedules.sqlite');
  const limits = { ...config, ...options };
  const store = await openWatchdogScheduleStore(path, 'local', limits);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const command = (value, now = start, identity = human, commandId = randomUUID()) => store.command(identity, scheduleCommandSchema.parse({ commandId, command: value }), now);
  const create = (id = 'plan', missed = 'coalesce', catchUpLimit = 3, now = start) => command({ type: 'create', id, sessionId: 'session', prompt: 'Inspect selected records. Do not write without approval.', rule: { kind: 'every', everySeconds: 300 }, missed, catchUpLimit }, now);
  const instances = (id = 'plan', now = start) => store.query(human, now, id).records;
  return { store, root, path, limits, command, create, instances };
}

test('missed work is skipped, coalesced or bounded across long downtime and a backwards clock', async t => {
  const f = await fixture(t, { maxPendingPerPlan: 2 });
  for (const mode of ['skip', 'coalesce', 'catch-up']) f.create(mode, mode, 100);
  const now = start + 300000 * 10000 + 20000;
  f.store.materialize(now);
  assert.equal(f.instances('skip').length, 0);
  assert.equal(f.instances('coalesce').length, 1);
  assert.equal(f.instances('catch-up').length, 2);
  assert.equal(f.store.plan('catch-up').missedCount, 9998);
  assert.equal(f.store.plan('catch-up').nextAt, start + 300000 * 10001);
  f.store.materialize(now - 300000);
  f.store.materialize(now);
  assert.equal(f.instances('catch-up').length, 2);
  f.store.materialize(now + 300000 * 100);
  assert.equal(f.instances('catch-up').length, 2, 'Pending capacity is shared across polls, not only one catch-up batch.');
});

test('official timezone validation rejects DST gaps and preserves UTC fixed-rate anchors', async t => {
  const f = await fixture(t);
  assert.throws(() => f.command({ type: 'create', id: 'dst', sessionId: 'session', prompt: 'Review', rule: { kind: 'at', at: { date: '2026-03-08', time: '02:30', time_zone: 'America/New_York' } }, missed: 'coalesce', catchUpLimit: 1 }));
  f.command({ type: 'create', id: 'utc', sessionId: 'session', prompt: 'Review', rule: { kind: 'at', at: '2026-03-08T03:30:00-04:00' }, missed: 'coalesce', catchUpLimit: 1 });
  f.store.materialize(Date.parse('2026-03-08T07:30:00Z'));
  assert.equal(f.instances('utc')[0].scheduledAt, Date.parse('2026-03-08T07:30:00Z'));
  assert.equal(f.store.plan('utc').active, false);
});

test('approval absence times out; plan cancellation and instance cancellation have separate effects', async t => {
  const f = await fixture(t); f.create(); f.store.materialize(start + 300000);
  const instance = f.instances()[0];
  assert.equal(f.store.claim('worker', start + 300001), undefined);
  f.command({ type: 'cancel-plan', id: 'plan', reason: 'No further occurrences' });
  assert.equal(f.store.instance(instance.id).state, 'waiting_approval');
  f.store.heartbeat('observer', instance.expiresAt);
  assert.equal(f.store.instance(instance.id).reason, 'approval_timeout');
  assert.throws(() => f.command({ type: 'approve', id: 'plan', instanceId: instance.id }, instance.expiresAt), { code: 'state_conflict' });
  f.create('second'); f.store.materialize(start + 300000);
  const other = f.instances('second')[0];
  f.command({ type: 'cancel-instance', id: 'second', instanceId: other.id, reason: 'This occurrence only' });
  assert.equal(f.store.plan('second').active, true);
  assert.equal(f.store.instance(other.id).state, 'cancelled');
});

test('commands survive reopen with exact receipts, ownership binding and divergent configuration rejection', async t => {
  const f = await fixture(t); const created = f.create();
  const request = scheduleCommandSchema.parse({ commandId: 'cancel', command: { type: 'cancel-plan', id: 'plan', reason: 'Stop future work' } });
  const receipt = f.store.command(human, request, start + 1);
  const second = await openWatchdogScheduleStore(f.path, 'local', f.limits);
  try {
    assert.deepEqual(second.command(human, request, start + 900), receipt);
    assert.equal(second.plan('plan').sessionId, created.sessionId);
    assert.throws(() => second.command({ ...human, actor: { kind: 'member', id: 'other' } }, request, start), { code: 'command_conflict' });
    assert.throws(() => second.query({ ...human, organizationId: 'other' }, start), { code: 'permission_denied' });
  } finally { second.close(); }
  await assert.rejects(openWatchdogScheduleStore(f.path, 'other', f.limits), { code: 'invalid_configuration' });
  await assert.rejects(openWatchdogScheduleStore(f.path, 'local', { ...f.limits, maxConcurrent: 4 }), { code: 'invalid_configuration' });
});

test('fencing prevents a lost worker from dispatching; barrier loss becomes human-resolved uncertainty', async t => {
  const f = await fixture(t); f.create(); const now = start + 300000; f.store.materialize(now);
  const instance = f.instances()[0]; f.command({ type: 'approve', id: 'plan', instanceId: instance.id }, now);
  const first = f.store.claim('first', now);
  f.store.heartbeat('second', now + 1001);
  const second = f.store.claim('second', now + 1101);
  assert.equal(f.store.beginDispatch(first, now + 1101), false);
  assert.equal(f.store.beginDispatch(second, now + 1101), true);
  f.store.heartbeat('observer', now + 2202);
  assert.equal(f.store.instance(instance.id).state, 'uncertain');
  assert.equal(f.store.claim('third', now + 3000), undefined);
  f.store.settle(second, now + 2202, 'dispatched', 'Stale worker');
  assert.equal(f.store.instance(instance.id).state, 'uncertain');
  assert.throws(() => f.command({ type: 'resolve-uncertain', id: 'plan', instanceId: instance.id, resolution: 'acknowledge-dispatched', reason: 'I checked' }, now, { ...human, actor: { kind: 'agent', id: 'session' } }), { code: 'permission_denied' });
  f.command({ type: 'resolve-uncertain', id: 'plan', instanceId: instance.id, resolution: 'acknowledge-dispatched', reason: 'Inspected the durable inbox occurrence id.' }, now + 4000);
  assert.equal(f.store.instance(instance.id).state, 'dispatched');
  assert.match(JSON.stringify(f.store.history(human, 'plan')), /Inspected the durable inbox/);
});

test('shared dispatch budget, concurrency, expiry and retry attempts are enforced independently of workers', async t => {
  const f = await fixture(t, { maxDispatchesPerWindow: 1, maxConcurrent: 2, maxAttempts: 2 });
  f.create('first'); f.create('second'); const now = start + 300000; f.store.materialize(now);
  for (const id of ['first', 'second']) f.command({ type: 'approve', id, instanceId: f.instances(id)[0].id }, now);
  const first = f.store.claim('one', now);
  assert.equal(f.store.claim('two', now), undefined);
  f.store.settle(first, now, 'retry', 'offline');
  const second = f.store.claim('two', now);
  f.store.beginDispatch(second, now); f.store.settle(second, now, 'dispatched', 'inbox_persisted');
  assert.equal(f.store.claim('three', now + 101), undefined);
  const g = await fixture(t, { maxAttempts: 2 }); g.create(); g.store.materialize(now);
  g.command({ type: 'approve', id: 'plan', instanceId: g.instances()[0].id }, now);
  const a = g.store.claim('a', now); g.store.settle(a, now, 'retry', 'offline');
  assert.equal(g.store.claim('b', now + 99), undefined);
  const b = g.store.claim('b', now + 100); g.store.settle(b, now + 100, 'retry', 'offline');
  assert.equal(g.store.instance(b.id).state, 'failed');
});

test('busy admission preserves attempts and deadlines while withdrawing stale worker ownership', async t => {
  const f = await fixture(t, { maxAttempts: 2 }); f.create(); const now = start + 300000; f.store.materialize(now);
  const instance = f.instances()[0]; f.command({ type: 'approve', id: 'plan', instanceId: instance.id }, now);
  const observer = await openWatchdogScheduleStore(f.path, 'local', f.limits);
  try {
    for (let index = 0; index < 4; index++) {
      const at = now + index * 100;
      const lease = f.store.claim('worker', at);
      f.store.deferBusy(lease, at);
      const deferred = observer.instance(instance.id);
      assert.equal(deferred.state, 'ready'); assert.equal(deferred.attempts, 0);
      assert.equal(deferred.expiresAt, instance.expiresAt); assert.equal(deferred.finishedAt, null);
      assert.equal(observer.beginDispatch(lease, at), false);
    }
    const current = observer.claim('replacement', now + 400);
    f.store.deferBusy({ ...current, fence: current.fence - 1 }, now + 400);
    assert.equal(observer.instance(instance.id).state, 'leased');
    assert.equal(observer.beginDispatch(current, now + 400), true);
    observer.settle(current, now + 400, 'dispatched', 'inbox_persisted');
    assert.equal(f.store.instance(instance.id).attempts, 1);
    assert.equal(f.store.instance(instance.id).state, 'dispatched');
  } finally { observer.close(); }
});

test('approval admission survives worker loss and requires a fresh grant within the original deadline', async t => {
  const f = await fixture(t); f.create(); const now = start + 300000; f.store.materialize(now);
  const instance = f.instances()[0]; f.command({ type: 'approve', id: 'plan', instanceId: instance.id }, now);
  const lease = f.store.claim('lost-worker', now);
  assert.equal(f.store.beginApproval(lease, now), true);
  const replacement = await openWatchdogScheduleStore(f.path, 'local', f.limits);
  try {
    replacement.heartbeat('replacement', now + 1001);
    const waiting = replacement.instance(instance.id);
    assert.equal(waiting.state, 'waiting_approval'); assert.equal(waiting.approvedBy, null);
    assert.equal(waiting.reason, 'approval_required_after_interrupted_admission');
    assert.equal(waiting.expiresAt, instance.expiresAt); assert.equal(waiting.finishedAt, null);
    assert.equal(replacement.claim('replacement', now + 2000), undefined);
    assert.equal(f.store.beginDispatch(lease, now + 2000), false);
    f.store.settle(lease, now + 2000, 'dispatched', 'late worker');
    assert.equal(replacement.instance(instance.id).state, 'waiting_approval');
    f.command({ type: 'approve', id: 'plan', instanceId: instance.id }, now + 2000);
    const fresh = replacement.claim('replacement', now + 2000);
    assert.equal(replacement.beginApproval(fresh, now + 2000), true);
    replacement.settle(fresh, now + 2001, 'retry', 'authority_unavailable');
    assert.equal(f.store.instance(instance.id).state, 'waiting_approval');
    replacement.heartbeat('replacement', instance.expiresAt);
    assert.equal(f.store.instance(instance.id).state, 'failed');
    assert.throws(() => f.command({ type: 'approve', id: 'plan', instanceId: instance.id }, instance.expiresAt), { code: 'state_conflict' });
  } finally { replacement.close(); }
});

test('approval interruption after the dispatch barrier remains uncertain rather than requesting another grant', async t => {
  const f = await fixture(t); f.create(); const now = start + 300000; f.store.materialize(now);
  const instance = f.instances()[0]; f.command({ type: 'approve', id: 'plan', instanceId: instance.id }, now);
  const lease = f.store.claim('worker', now);
  assert.equal(f.store.beginApproval(lease, now), true);
  assert.equal(f.store.beginDispatch(lease, now), true);
  f.store.settle(lease, now, 'retry', 'inbox_persistence_unconfirmed');
  assert.equal(f.store.instance(instance.id).state, 'uncertain');
  assert.equal(f.store.claim('replacement', now + 2000), undefined);
});

test('schema 1 upgrade refuses fresh workers and retains receipts and audit while recovering old claims conservatively', async t => {
  const f = await fixture(t); const now = Date.now();
  for (const id of ['leased', 'dispatching']) f.create(id, 'coalesce', 1, now - 300000);
  f.store.materialize(now);
  const instances = ['leased', 'dispatching'].map(id => f.instances(id)[0]);
  const request = scheduleCommandSchema.parse({ commandId: 'approval-receipt', command: { type: 'approve', id: 'leased', instanceId: instances[0].id } });
  const receipt = f.store.command(human, request, now);
  f.command({ type: 'approve', id: 'dispatching', instanceId: instances[1].id }, now);
  const leases = [f.store.claim('first', now), f.store.claim('second', now)];
  const dispatching = leases.find(lease => lease.planId === 'dispatching');
  assert.equal(f.store.beginDispatch(dispatching, now), true);
  f.store.heartbeat('first', now);
  const old = new DatabaseSync(f.path);
  let upgraded;
  try {
    old.exec('PRAGMA user_version=1');
    const records = old.prepare('SELECT * FROM schedule_audit ORDER BY seq').all();
    const plans = old.prepare('SELECT * FROM schedule_plans ORDER BY id').all();
    const commands = old.prepare('SELECT * FROM schedule_commands ORDER BY id').all();
    await assert.rejects(openWatchdogScheduleStore(f.path, 'local', f.limits), { code: 'invalid_configuration' });
    assert.equal(old.prepare('PRAGMA user_version').get().user_version, 1);
    assert.deepEqual(old.prepare('SELECT * FROM schedule_audit ORDER BY seq').all(), records, 'A refused upgrade makes no audit or state changes.');
    f.store.heartbeat('first', now, 'worker_stopped');
    upgraded = await openWatchdogScheduleStore(f.path, 'local', f.limits);
    assert.equal(old.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual(old.prepare('SELECT * FROM schedule_plans ORDER BY id').all(), plans);
    assert.deepEqual(old.prepare('SELECT * FROM schedule_commands ORDER BY id').all(), commands);
    assert.deepEqual(old.prepare('SELECT * FROM schedule_audit ORDER BY seq').all().slice(0, records.length), records);
    assert.deepEqual(upgraded.command(human, request, now + 1), receipt);
    upgraded.heartbeat('new-worker', now + 1001);
    assert.equal(upgraded.instance(instances[0].id).state, 'waiting_approval');
    assert.equal(upgraded.instance(instances[0].id).approvedBy, null);
    assert.equal(upgraded.instance(instances[1].id).state, 'uncertain');
    assert.equal(upgraded.claim('new-worker', now + 2000), undefined);
  } finally { upgraded?.close(); old.close(); }
});

test('independent read-only observer sees stale heartbeat and expired lease without an agent or active worker', async t => {
  const f = await fixture(t); f.create(); const now = start + 300000; f.store.materialize(now);
  f.command({ type: 'approve', id: 'plan', instanceId: f.instances()[0].id }, now);
  f.store.heartbeat('worker', now); f.store.claim('worker', now);
  const observer = await openWatchdogScheduleStore(f.path, 'local', f.limits);
  try {
    const status = observer.query(human, now + 1001, 'plan');
    assert.equal(status.workers[0].stale, true);
    assert.equal(status.records[0].leaseExpired, true);
    assert.equal(status.records[0].state, 'leased', 'The observer does not mutate the execution ledger.');
  } finally { observer.close(); }
});

test('two real worker processes cannot repeat the same side effect after one crashes behind the barrier', async t => {
  const f = await fixture(t); f.create(); const now = start + 300000; f.store.materialize(now);
  f.command({ type: 'approve', id: 'plan', instanceId: f.instances()[0].id }, now);
  const effects = join(f.root, 'effects.txt');
  const workers = ['left', 'right'].map(id => fork(new URL('./fixtures/watchdog-schedule-worker.mjs', import.meta.url), [f.path, JSON.stringify(f.limits), String(now), id, effects],
    { execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  const exits = workers.map(worker => once(worker, 'exit'));
  t.after(async () => { for (const worker of workers) if (worker.exitCode === null) worker.kill(); await Promise.allSettled(exits); });
  await Promise.all(workers.map(worker => once(worker, 'message')));
  for (const worker of workers) worker.send('claim');
  const codes = (await Promise.all(exits)).map(([code]) => code).sort();
  assert.deepEqual(codes, [0, 72]);
  const instance = f.instances()[0];
  assert.equal((await readFile(effects, 'utf8')).trim(), instance.id);
  f.store.heartbeat('recovery', now + 1001);
  assert.equal(f.store.instance(instance.id).state, 'uncertain');
  assert.equal(f.store.claim('replacement', now + 2000), undefined);
  assert.equal((await readFile(effects, 'utf8')).trim().split('\n').length, 1);
});
