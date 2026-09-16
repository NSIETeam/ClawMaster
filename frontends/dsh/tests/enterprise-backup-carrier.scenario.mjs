import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { receiveStreamingRefusal } from './http-stream-fixture.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bridge } from '../../../packages/client/connection/src/http-bridge.ts';
import { mountEnterpriseRoutes, openEnterpriseStore } from '../src/enterprise-host.ts';
import { GovernanceAccess } from '../src/governance-access.ts';

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clawmaster-backup-carrier-'));
  const store = await openEnterpriseStore(join(directory, 'records.sqlite'));
  const routes = new Map();
  const dispose = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path); } } } }, store, new GovernanceAccess(), config);
  const handler = {
    requestBodyMode: ({ url }) => routes.get(url.pathname)?.requestBody ?? 'buffered',
    fetch: request => routes.get(new URL(request.url).pathname)?.fetch(request) ?? Promise.resolve(new Response(null, { status: 404 })),
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
