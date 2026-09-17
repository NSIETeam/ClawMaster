import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openEnterpriseStore, mountEnterpriseRoutes } from '../src/enterprise-host.ts';
import { LOCAL_HTTP_IDENTITY, initializeResponsibilityHistory, listPendingTaskExecutionOutcomes, recordTaskExecutionOutcome } from '../src/governance-audit.ts';

const contact = name => ({ type: 'contact.upsert', contact: { id: 'customer', name, company: '', stage: 'lead', nextAction: '', nextActionDate: null } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'responsibility-'));
  const path = join(root, 'records.sqlite');
  const store = await openEnterpriseStore(path);
  t.after(async () => { store.close(); await rm(root, { force: true, recursive: true }); });
  return { store, path };
}

test('A backup, B mutation and restore retain B responsibility with actor and approved revision', async t => {
  const { store, path } = await fixture(t);
  store.execute({ revision: 0, commandId: 'a', command: contact('A') }, LOCAL_HTTP_IDENTITY);
  const backup = store.backup(LOCAL_HTTP_IDENTITY);
  const agent = { ...LOCAL_HTTP_IDENTITY, actor: { kind: 'agent', id: 'session-1' }, source: 'tool', sessionId: 'session-1', callId: 'call-2',
    approval: { kind: 'authority', id: 'approved-2', approverId: 'reviewer-2', generation: 0, revision: 1 } };
  store.execute({ revision: 1, commandId: 'b', command: contact('B') }, agent);
  const restoreIdentity = { ...LOCAL_HTTP_IDENTITY, actor: { kind: 'member', id: 'restore-operator' },
    approval: { kind: 'authority', id: 'restore-approved', approverId: 'restore-reviewer', generation: 0, revision: 2 } };
  const restored = store.restore(backup, 2, 0, restoreIdentity, 'restore-a');
  assert.equal(restored.contacts[0].name, 'A');
  assert.equal(restored.audit.some(row => row.commandId === 'b'), false);
  const responsibility = store.responsibility({ commandId: 'b' }).records;
  assert.equal(responsibility.length, 1);
  assert.deepEqual(responsibility[0].identity, agent);
  assert.equal(JSON.stringify(responsibility).includes('"name":"B"'), false);
  const restoreRecords = store.responsibility({ commandId: 'restore-a' }).records;
  assert.equal(restoreRecords.length, 1);
  assert.equal(restoreRecords[0].operation, 'backup.restore');
  assert.equal(restoreRecords[0].outcome, 'succeeded');
  assert.deepEqual(restoreRecords[0].identity, restoreIdentity);
  assert.equal(restoreRecords[0].generationBefore, 0);
  assert.equal(restoreRecords[0].revisionBefore, 2);
  assert.equal(restoreRecords[0].generationAfter, 1);
  assert.equal(restoreRecords[0].revisionAfter, 1);
  assert.match(restoreRecords[0].backupSha256, /^[a-f0-9]{64}$/);
  const beforeRetry = store.responsibility().records;
  assert.deepEqual(store.restore(backup, 2, 0, restoreIdentity, 'restore-a'), restored);
  assert.deepEqual(store.responsibility().records, beforeRetry);
  assert.throws(() => store.restore(backup, 1, 0, restoreIdentity, 'restore-a'), { code: 'command_conflict' });
  const reopened = await openEnterpriseStore(path);
  try {
    assert.deepEqual(reopened.responsibility({ commandId: 'b' }).records, responsibility);
    const reopenedRestoreRecords = reopened.responsibility({ commandId: 'restore-a' }).records;
    assert.deepEqual(reopenedRestoreRecords[0], restoreRecords[0]);
    assert.deepEqual(reopenedRestoreRecords.map(row => row.outcome), ['succeeded', 'failed']);
    assert.equal(reopenedRestoreRecords[1].reasonCode, 'command_conflict');
  }
  finally { reopened.close(); }
});

test('restore validation and transaction failures retain distinct failed outcomes without success', async t => {
  const { store, path } = await fixture(t);
  const backup = store.backup();
  store.execute({ revision: 0, commandId: 'a', command: contact('A') });
  assert.throws(() => store.restore({}, 1, 0, LOCAL_HTTP_IDENTITY, 'invalid'));
  const fault = new DatabaseSync(path);
  try {
    fault.exec("CREATE TRIGGER fail_restore BEFORE DELETE ON contacts BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
    assert.throws(() => store.restore(backup, 1, 0, LOCAL_HTTP_IDENTITY, 'failed'), { code: 'storage_invalid' });
    assert.equal(store.snapshot().contacts[0].name, 'A');
    assert.equal(store.snapshot().generation, 0);
    assert.equal(store.responsibility({ commandId: 'failed' }).records[0].outcome, 'failed');
    assert.equal(store.responsibility({ commandId: 'invalid' }).records[0].reasonCode, 'backup_invalid');
    assert.equal(store.responsibility({ operation: 'backup.restore' }).records.some(row => row.outcome === 'succeeded'), false);
  } finally { fault.close(); }
});

test('audit append failure aborts business changes and immutable history rejects deletion', async t => {
  const { store, path } = await fixture(t);
  store.execute({ revision: 0, commandId: 'a', command: contact('A') });
  const fault = new DatabaseSync(path);
  try {
    assert.throws(() => fault.exec('DELETE FROM responsibility_history'));
    fault.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON responsibility_history BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
    assert.throws(() => store.execute({ revision: 1, commandId: 'b', command: contact('B') }));
    assert.equal(store.snapshot().contacts[0].name, 'A');
    assert.equal(store.snapshot().revision, 1);
  } finally { fault.close(); }
});

test('schema 2 audit imports unknown identity and chain tampering prevents reopening', async t => {
  const { store, path } = await fixture(t);
  store.execute({ revision: 0, commandId: 'a', command: contact('A') });
  store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP TABLE responsibility_history; DROP TABLE restore_receipts; PRAGMA user_version=2;');
  legacy.close();
  const migrated = await openEnterpriseStore(path);
  const records = migrated.responsibility().records;
  assert.equal(records.length, 1);
  assert.equal(records[0].identity.actor.kind, 'unknown');
  assert.equal(records[0].outcome, 'legacy');
  migrated.close();
  const tamper = new DatabaseSync(path);
  tamper.exec("DROP TRIGGER responsibility_no_update; UPDATE responsibility_history SET body=json_set(body, '$.operation', 'changed');");
  tamper.close();
  await assert.rejects(openEnterpriseStore(path), { code: 'storage_invalid' });
});

test('rejected schema 1 organization migration leaves the old schema retryable and preserves records', async t => {
  const { store, path } = await fixture(t);
  store.execute({ revision: 0, commandId: 'legacy-command', command: contact('Legacy customer') });
  store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec(`DROP TABLE responsibility_history; DROP TABLE restore_receipts;
    DROP TABLE watchdog_task_history; DROP TABLE watchdog_tasks; DROP TABLE enterprise_organization;
    ALTER TABLE enterprise_meta DROP COLUMN generation; PRAGMA user_version=1;`);
  const schema = legacy.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
  legacy.close();
  await assert.rejects(openEnterpriseStore(path, 5000, 'another-organization'), { code: 'storage_invalid' });
  const unchanged = new DatabaseSync(path);
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 1);
    assert.deepEqual(unchanged.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(), schema);
    assert.equal(unchanged.prepare('SELECT name FROM contacts').get().name, 'Legacy customer');
  } finally { unchanged.close(); }
  const migrated = await openEnterpriseStore(path);
  try {
    assert.equal(migrated.snapshot().contacts[0].name, 'Legacy customer');
    assert.equal(migrated.responsibility().records[0].commandId, 'legacy-command');
  } finally { migrated.close(); }
  const reopened = await openEnterpriseStore(path);
  try { assert.equal(reopened.responsibility().records.length, 1); }
  finally { reopened.close(); }
});

test('HTTP command rejects forged actor and responsibility query is bounded', async t => {
  const { store } = await fixture(t);
  const routes = new Map();
  const dispose = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => routes.delete(route.path); } } } }, store);
  try {
    const send = value => routes.get('/api/clawmaster/enterprise/command')(new Request('http://fixture/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }));
    assert.equal((await send({ revision: 0, commandId: 'forged', command: contact('X'), actor: { id: 'administrator' }, approvalId: 'fake' })).status, 400);
    assert.equal((await send({ revision: 0, commandId: 'valid', command: contact('A') })).status, 200);
    assert.deepEqual(store.responsibility({ commandId: 'valid' }).records[0].identity, LOCAL_HTTP_IDENTITY);
    assert.throws(() => store.responsibility({ limit: 501 }));
  } finally { await dispose(); }
});


test('task dispatch responsibility preserves uncertain and terminal facts with exact request idempotency', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE enterprise_meta(singleton INTEGER PRIMARY KEY, generation INTEGER NOT NULL); INSERT INTO enterprise_meta VALUES (1, 0);
    CREATE TABLE enterprise_audit(revision INTEGER, commandId TEXT, type TEXT, entityId TEXT);`);
  initializeResponsibilityHistory(db);
  const identity = { ...LOCAL_HTTP_IDENTITY, actor: { kind: 'member', id: 'member-1' }, organizationId: 'org-1', principalId: 'member-1', policyVersion: 7 };
  const value = { taskId: 'task-1', requestId: 'request-1', sessionId: 'session-1' };
  const binding = () => ({ taskRevision: 4, commandId: 'start-1' });
  try {
    const uncertain = recordTaskExecutionOutcome(db, identity, { ...value, outcome: 'uncertain' }, binding);
    assert.equal(uncertain.sequence, 1);
    assert.deepEqual(uncertain.taskExecution, { requestId: 'request-1', sessionId: 'session-1' });
    assert.deepEqual(listPendingTaskExecutionOutcomes(db), [{ requestId: 'request-1', sessionId: 'session-1' }]);
    assert.equal(recordTaskExecutionOutcome(db, identity, { ...value, outcome: 'uncertain' }, binding).hash, uncertain.hash);
    const succeeded = recordTaskExecutionOutcome(db, identity, { ...value, outcome: 'succeeded' }, binding);
    assert.equal(succeeded.sequence, 2);
    assert.equal(succeeded.outcome, 'succeeded');
    assert.deepEqual(listPendingTaskExecutionOutcomes(db), []);
    assert.equal(recordTaskExecutionOutcome(db, identity, { ...value, outcome: 'uncertain' }, binding).hash, succeeded.hash);
    assert.equal(recordTaskExecutionOutcome(db, identity, { ...value, outcome: 'succeeded' }, binding).hash, succeeded.hash);
    assert.throws(() => recordTaskExecutionOutcome(db, identity, { ...value, outcome: 'failed', reasonCode: 'session_submission_failed' }, binding), { code: 'command_conflict' });
    const failedInput = { ...value, requestId: 'request-2' };
    const failedBinding = () => ({ taskRevision: 4, commandId: 'start-2' });
    recordTaskExecutionOutcome(db, identity, { ...failedInput, outcome: 'uncertain' }, failedBinding);
    const failed = recordTaskExecutionOutcome(db, identity, { ...failedInput, outcome: 'failed', reasonCode: 'session_submission_failed' }, failedBinding);
    assert.equal(failed.outcome, 'failed');
    assert.equal(recordTaskExecutionOutcome(db, identity, { ...failedInput, outcome: 'failed', reasonCode: 'session_submission_failed' }, failedBinding).hash, failed.hash);
    assert.throws(() => recordTaskExecutionOutcome(db, { ...identity, actor: { kind: 'member', id: 'other' } },
      { ...value, outcome: 'uncertain' }, binding), { code: 'command_conflict' });
    assert.throws(() => recordTaskExecutionOutcome(db, identity, { ...value, outcome: 'uncertain' },
      () => ({ taskRevision: 5, commandId: 'start-1' })), { code: 'command_conflict' });
    const beforeRejectedBinding = db.prepare('SELECT COUNT(*) AS count FROM responsibility_history').get().count;
    assert.throws(() => recordTaskExecutionOutcome(db, identity, { ...failedInput, outcome: 'uncertain' }, () => { throw new Error('stale binding'); }));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM responsibility_history').get().count, beforeRejectedBinding);
  } finally { db.close(); }
});
