/** Backup files cross the HTTP routes without browser JSON parsing; restores resolve by durable receipt. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnterpriseClient } from '../src/enterprise-client.ts';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { enterpriseTransport, overviewOf } from './enterprise-transport.fixture.mjs';

const empty = { generation: 0, revision: 0, contacts: [], inventory: [], orders: [], audit: [] };
const prepared = { token: 'prepared-token', backupSha256: 'a'.repeat(64), exportedAt: '2026-09-16T00:00:00.000Z', generation: 0, revision: 0,
  counts: { contacts: 0, inventory: 0, orders: 0, audit: 0 } };
const contact = { id: 'backup-contact', name: 'Original contact', company: '', stage: 'lead', nextAction: '', nextActionDate: null };

test('download stays a Blob and preparation forwards the original file without reading or parsing its contents', async () => {
  const file = new Blob(['file bytes are owned by the server'], { type: 'application/json' });
  file.text = async () => { throw new Error('Browser text parsing is forbidden.'); };
  file.arrayBuffer = async () => { throw new Error('Browser buffering is forbidden.'); };
  const client = new EnterpriseClient(async (path, init) => {
    if (path.endsWith('/prepare')) {
      assert.equal(init.body, file);
      assert.equal(init.headers['content-type'], 'application/json');
      return Response.json(prepared);
    }
    const response = new Response('download bytes', { headers: { 'content-type': 'application/json' } });
    response.json = async () => { throw new Error('Backup download cannot parse JSON.'); };
    return response;
  });
  assert.deepEqual(await client.prepareBackup(file), prepared);
  assert.equal(await (await client.backup()).text(), 'download bytes');
  assert.equal(client.getSnapshot().backupOperation, null);
});

test('real file routes confirm a lost restore receipt after token disposal without overwriting later writes', async context => {
  const root = await mkdtemp(join(tmpdir(), 'enterprise-backup-client-'));
  const store = await openEnterpriseStore(join(root, 'enterprise.sqlite'));
  const transport = await enterpriseTransport(store);
  context.after(async () => { await transport.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  const write = (name, commandId) => store.executeReceipt({ generation: store.overview().generation, revision: store.overview().revision,
    commandId, command: { type: 'contact.upsert', contact: { ...contact, name } } });
  write('Original contact', 'seed');
  const requests = [];
  let loseResponse = true;
  const client = new EnterpriseClient(async (path, init) => {
    if (path.endsWith('/restore')) requests.push(JSON.parse(init.body));
    const response = await transport.fetch(path, init);
    if (path.endsWith('/restore') && response.ok && loseResponse) { loseResponse = false; throw new TypeError('Restore receipt lost in transit.'); }
    return response;
  }, () => 'same-restore-request');
  await client.refresh();
  const file = await client.backup();
  assert.equal(file instanceof Blob, true);
  const review = await client.prepareBackup(file);
  assert.deepEqual(review.counts, { contacts: 1, inventory: 0, orders: 0, audit: 1 });
  assert.equal('snapshot' in review, false);
  write('Later before restore', 'before-restore');
  await client.refresh();
  await assert.rejects(client.restore(review, 2, 0), /lost in transit/);
  assert.equal(store.snapshot().contacts[0].name, 'Original contact');
  assert.equal(store.overview().generation, 1);
  await client.refresh();
  assert.equal(client.getSnapshot().pending, true);
  write('Later after restore', 'after-restore');
  const receipt = await client.retryRestore();
  assert.equal(receipt.revision, 1);
  assert.equal(receipt.generation, 1);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(Object.keys(requests[0]).sort(), ['backupSha256', 'commandId', 'confirm', 'expectedGeneration', 'expectedRevision', 'token']);
  assert.equal(store.snapshot().contacts[0].name, 'Later after restore');
  assert.equal(store.overview().generation, 1);
  const restoreEvents = store.responsibility({ commandId: 'same-restore-request' }).records;
  assert.equal(restoreEvents.length, 1, 'the committed restore and its response-loss retry share one responsibility event');
  assert.equal(restoreEvents[0].outcome, 'succeeded');
  assert.equal(restoreEvents[0].generationBefore, 0);
  assert.equal(restoreEvents[0].generationAfter, 1);
  assert.equal(client.getSnapshot().pending, false);
  assert.equal(client.getSnapshot().overview.revision, 2);
});

test('cancelled preparation aborts the active HTTP request without creating an unresolved mutation', async () => {
  let signal;
  const client = new EnterpriseClient(async (_path, init) => new Promise((_resolve, reject) => {
    signal = init.signal;
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }));
  const operation = client.prepareBackup(new Blob(['{}']));
  assert.equal(client.getSnapshot().backupOperation, 'prepare');
  client.cancelBackupOperation();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  assert.equal(client.getSnapshot().pending, false);
  assert.equal(client.getSnapshot().saving, false);
  assert.equal(client.getSnapshot().error, 'operation_cancelled');
});

test('cancelled restore retains the original request until its receipt or definite no-commit response is obtained', async () => {
  const requests = [];
  const client = new EnterpriseClient(async (path, init) => {
    if (init.method === 'GET') return Response.json(overviewOf(empty));
    requests.push(JSON.parse(init.body));
    if (requests.length > 1) return Response.json({ error: { code: 'invalid_request', message: 'No receipt or staged file exists.' } }, { status: 400 });
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  }, () => 'cancelled-restore');
  await client.refresh();
  const operation = client.restore(prepared, 0, 0);
  client.cancelBackupOperation();
  await assert.rejects(operation, { name: 'AbortError' });
  await client.refresh();
  assert.equal(client.getSnapshot().pending, true);
  assert.equal(client.getSnapshot().restoreUncertain, true);
  await assert.rejects(client.retryRestore(), { code: 'invalid_request' });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(client.getSnapshot().pending, false);
  assert.equal(client.getSnapshot().restoreUncertain, false);
});

for (const patch of [{ commandId: 'unrelated' }, { backupSha256: 'b'.repeat(64) }, { generation: 2 }, { revision: 1 }]) {
  test(`a mismatched restore receipt stays unresolved: ${JSON.stringify(patch)}`, async () => {
    const client = new EnterpriseClient(async (_path, init) => Response.json(init.method === 'GET' ? overviewOf(empty)
      : { commandId: 'expected-restore', backupSha256: prepared.backupSha256, generation: 1, revision: 0, ...patch }), () => 'expected-restore');
    await client.refresh();
    await assert.rejects(client.restore(prepared, 0, 0), { code: 'invalidResponse' });
    await client.refresh();
    assert.equal(client.getSnapshot().pending, true);
  });
}

test('a confirmed restore remains confirmed when its subsequent overview refresh fails', async () => {
  let restored = false;
  const client = new EnterpriseClient(async (_path, init) => {
    if (init.method === 'POST') {
      restored = true;
      return Response.json({ commandId: 'confirmed-restore', backupSha256: prepared.backupSha256, generation: 1, revision: 0 });
    }
    if (restored) throw new TypeError('Read unavailable.');
    return Response.json(overviewOf(empty));
  }, () => 'confirmed-restore');
  await client.refresh();
  assert.equal((await client.restore(prepared, 0, 0)).generation, 1);
  assert.equal(client.getSnapshot().pending, false);
  assert.equal(client.getSnapshot().error, 'networkError');
  assert.equal(await client.retryRestore(), null);
});
