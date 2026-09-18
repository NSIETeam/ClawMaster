import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { receiveStreamingRefusal } from './http-stream-fixture.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { bridge } from '../../../packages/client/connection/src/http-bridge.ts';
import { mountEnterpriseRoutes, openEnterpriseStore } from '../src/enterprise-host.ts';
import { GovernanceAccess } from '../src/governance-access.ts';
import { LOCAL_HTTP_IDENTITY } from '../src/governance-audit.ts';

async function fixture(t, config = {}, afterRoute) {
  const directory = await mkdtemp(join(tmpdir(), 'clawmaster-backup-carrier-'));
  const store = await openEnterpriseStore(join(directory, 'records.sqlite'));
  const routes = new Map();
  const dispose = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path); } } } }, store, new GovernanceAccess(), config);
  const handler = {
    requestBodyMode: ({ url }) => routes.get(url.pathname)?.requestBody ?? 'buffered',
    fetch: async request => {
      const path = new URL(request.url).pathname;
      const response = await routes.get(path)?.fetch(request) ?? new Response(null, { status: 404 });
      return afterRoute ? afterRoute(path, response) : response;
    },
  };
  const server = createServer((request, response) => {
    void bridge(request, response, handler).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  t.after(async () => {
    try { await dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { base: `http://127.0.0.1:${server.address().port}`, store };
}

test('backup GET and file preparation/restore work through the production node HTTP bridge', async t => {
  const { base, store } = await fixture(t);
  const response = await fetch(base + '/api/clawmaster/enterprise/backup');
  assert.equal(response.status, 200);
  const backup = await response.text();
  assert.equal(Buffer.byteLength(backup), Number(response.headers.get('content-length')));
  const preparedResponse = await fetch(base + '/api/clawmaster/enterprise/backup/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: backup });
  assert.equal(preparedResponse.status, 200, await preparedResponse.clone().text());
  const prepared = await preparedResponse.json();
  const restored = await fetch(base + '/api/clawmaster/enterprise/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    token: prepared.token, backupSha256: prepared.backupSha256, expectedGeneration: 0, expectedRevision: 0, commandId: 'bridge-restore', confirm: true,
  }) });
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.equal((await restored.json()).generation, 1);
  assert.equal(store.overview().generation, 1);
});

test('restore failures identify their stage and an exact retry recovers a committed result without losing responsibility history', async t => {
  let loseAcknowledgement = false;
  const { base, store } = await fixture(t, {}, async (path, response) => {
    if (path === '/api/clawmaster/enterprise/restore' && loseAcknowledgement && response.status === 200) {
      loseAcknowledgement = false;
      return new Response(null, { status: 503 });
    }
    return response;
  });
  const contact = name => ({ type: 'contact.upsert', contact: { id: 'customer', name, company: '', stage: 'lead', nextAction: '', nextActionDate: null } });
  store.execute({ revision: 0, commandId: 'write-a', command: contact('A') }, LOCAL_HTTP_IDENTITY);
  const backup = store.backup();
  store.execute({ revision: 1, commandId: 'write-b', command: contact('B') }, LOCAL_HTTP_IDENTITY);
  const prepare = async () => {
    const response = await fetch(base + '/api/clawmaster/enterprise/backup/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(backup) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const restore = (prepared, commandId, extra = {}) => fetch(base + '/api/clawmaster/enterprise/restore', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: prepared.token, backupSha256: prepared.backupSha256, expectedGeneration: 0, expectedRevision: 2, commandId, confirm: true, ...extra }) });

  const forged = await prepare();
  assert.equal((await restore(forged, 'forged-restore', { actor: { kind: 'member', id: 'administrator' }, approvalId: 'forged' })).status, 400);
  assert.equal(store.snapshot().contacts[0].name, 'B');

  const failed = await prepare();
  const fault = new DatabaseSync(store.backupDatabasePath());
  try { fault.exec("CREATE TRIGGER reject_restore BEFORE DELETE ON contacts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;"); }
  finally { fault.close(); }
  const failedResponse = await restore(failed, 'failed-restore');
  assert.notEqual(failedResponse.status, 200, await failedResponse.clone().text());
  const failure = store.responsibility({ commandId: 'failed-restore' }).records[0];
  assert.equal(failure?.outcome, 'failed', JSON.stringify(store.responsibility().records));
  assert.equal(failure.stage, 'apply');
  assert.equal(failure.reasonCode, 'operation_failed');
  assert.equal(store.snapshot().contacts[0].name, 'B');
  assert.equal(store.snapshot().generation, 0);

  const removeFault = new DatabaseSync(store.backupDatabasePath());
  try { removeFault.exec('DROP TRIGGER reject_restore;'); }
  finally { removeFault.close(); }
  const ready = await prepare();
  const exactRequest = { token: ready.token, backupSha256: ready.backupSha256, expectedGeneration: 0, expectedRevision: 2, commandId: 'restore-a', confirm: true };
  loseAcknowledgement = true;
  assert.equal((await fetch(base + '/api/clawmaster/enterprise/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactRequest) })).status, 503);
  assert.equal(store.snapshot().contacts[0].name, 'A');
  const retry = await fetch(base + '/api/clawmaster/enterprise/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exactRequest) });
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal((await retry.json()).generation, 1);
  const history = store.responsibility().records;
  assert.equal(history.filter(row => row.commandId === 'write-b').length, 1);
  assert.equal(history.find(row => row.commandId === 'write-b').identity.actor.id, 'local-operator');
  assert.deepEqual(history.filter(row => row.commandId === 'restore-a').map(row => row.outcome), ['succeeded']);
  assert.equal(history.find(row => row.commandId === 'restore-a').revisionBefore, 2);
});

for (const path of ['/backup/prepare', '/restore']) for (const mode of ['oversize', 'idle']) test(`${path} ${mode} upload returns structured refusal before server disconnection and releases admission`, async t => {
  // Keep the timeout under test bounded while leaving the complete retry request
  // enough time for Windows' loopback HTTP stack to deliver its small body.
  const { base, store } = await fixture(t, { maxFileBytes: 512, timeoutMs: 1000 });
  const received = await receiveStreamingRefusal(base + '/api/clawmaster/enterprise' + path, mode === 'oversize' ? '😀'.repeat(600) : '{');
  assert.equal(received.status, mode === 'oversize' ? 413 : 503);
  assert.equal(JSON.parse(received.body).error.code, mode === 'oversize' ? 'result_too_large' : 'storage_unavailable');
  const retry = await fetch(base + '/api/clawmaster/enterprise/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(retry.status, 400, await retry.clone().text());
  assert.equal((await retry.json()).error.code, 'invalid_request', 'The prior upload must release the backup job');
  assert.equal(store.overview().generation, 0);
});
