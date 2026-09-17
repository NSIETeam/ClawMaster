import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openEnterpriseStore, mountEnterpriseRoutes } from '../src/enterprise-host.ts';
import { GovernanceAccess } from '../src/governance-access.ts';
import { parseEnterpriseBackup } from '../src/enterprise-schema.ts';
const base = '/api/clawmaster/enterprise';
async function fixture(t, { config = {}, access = new GovernanceAccess(), organizationId = 'local' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cm-backup-test-'));
  const store = await openEnterpriseStore(join(directory, 'enterprise.sqlite'), 5000, organizationId);
  const routes = new Map();
  const dispose = await mountEnterpriseRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path); } } } }, store, access, config);
  t.after(async () => { await dispose(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const fetch = (path, init) => routes.get(base + path).fetch(new Request('http://localhost' + base + path, init));
  const upload = backup => fetch('/backup/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(backup) });
  const restore = (prepared, more = {}, signal) => fetch('/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: prepared.token, backupSha256: prepared.backupSha256, expectedGeneration: 0, expectedRevision: 1, commandId: 'restore-one', confirm: true, ...more }), ...(signal ? { signal } : {}) });
  store.execute({ generation: 0, revision: 0, commandId: 'contact-one', command: { type: 'contact.upsert', contact: { id: 'one', name: '一😀', company: '', stage: 'lead', nextAction: '', nextActionDate: null } } });
  return { store, routes, fetch, upload, restore, dispose };
}
test('streaming export, prepared import and durable narrow replay use real worker and exact identity', async t => {
  const f = await fixture(t);
  assert.equal(f.routes.get(base + '/backup/prepare').requestBody, 'streaming');
  const response = await f.fetch('/backup');
  assert.equal(response.status, 200, await response.clone().text());
  const bytes = await response.text();
  assert.equal(Buffer.byteLength(bytes), Number(response.headers.get('content-length')));
  const backup = parseEnterpriseBackup(JSON.parse(bytes));
  const preparation = await f.upload(backup);
  assert.equal(preparation.status, 200, await preparation.clone().text());
  const prepared = await preparation.json();
  assert.equal(prepared.counts.contacts, 1);
  const first = await f.restore(prepared);
  assert.equal(first.status, 200, await first.clone().text());
  const receipt = await first.json();
  assert.deepEqual(receipt, { commandId: 'restore-one', backupSha256: prepared.backupSha256, generation: 1, revision: 1 });
  assert.deepEqual(await (await f.restore(prepared)).json(), receipt);
  assert.equal(f.store.snapshot().generation, 1);
  assert.equal((await f.restore(prepared, { expectedRevision: 0 })).status, 409);
});
test('upload byte checks happen before oversized streams are read and count missing-length Unicode bodies', async t => {
  const f = await fixture(t, { config: { maxFileBytes: 512 } });
  let pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(4096)); } }, { highWaterMark: 0 });
  const rejected = await f.fetch('/backup/prepare', { method: 'POST', duplex: 'half', headers: { 'content-type': 'application/json', 'content-length': '4096' }, body });
  assert.equal(rejected.status, 413); assert.equal(pulls, 0);
  const missing = await f.fetch('/backup/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '😀'.repeat(300) });
  assert.equal(missing.status, 413);
  assert.equal((await f.fetch('/backup')).status, 413);
});
test('cross-record validation rejects corrupt backup before any target write', async t => {
  const f = await fixture(t); const backup = f.store.backup();
  backup.auditCommands[0].commandJson = JSON.stringify({ type: 'contact.remove', id: 'one' });
  const before = f.store.snapshot();
  assert.equal((await f.upload(backup)).status, 503);
  assert.deepEqual(f.store.snapshot(), before);
});
function enterpriseAuthority() {
  let active = true, afterApproval = false, checks = 0;
  let policyVersion = 1;
  let finalCheck = async () => {};
  const authority = {
    async http() { return { organizationId: 'acme', memberId: 'admin', actor: 'human' }; }, async agent() { return undefined; },
    async membership(_org, member) {
      if (afterApproval && member === 'admin') await finalCheck(++checks);
      return { active, roles: member === 'reviewer' ? ['approver'] : ['administrator'], policyVersion, resources: ['*'] };
    },
    async consumeApproval() { afterApproval = true; return { id: 'approved', approverId: 'reviewer' }; },
  };
  return { access: new GovernanceAccess({ mode: 'enterprise', organizationId: 'acme', authority }), revoke() { active = false; }, changePolicy() { policyVersion++; }, onFinalCheck(callback) { finalCheck = callback; } };
}
test('restore responsibility records the final checked policy and retains the independently consumed approval', async t => {
  const authority = enterpriseAuthority(); const f = await fixture(t, { access: authority.access, organizationId: 'acme' });
  const prepared = await (await f.upload(f.store.backup())).json();
  authority.onFinalCheck(async index => { if (index === 2) authority.changePolicy(); });
  const response = await f.restore(prepared);
  assert.equal(response.status, 200, await response.clone().text());
  const entry = f.store.responsibility().records.find(row => row.operation === 'backup.restore' && row.outcome === 'succeeded');
  assert.equal(entry.identity.policyVersion, 2);
  assert.equal(entry.identity.approval.kind, 'authority');
  assert.equal(entry.identity.approval.id, 'approved');
  assert.equal(entry.identity.approval.approverId, 'reviewer');
});
test('authority revoked across approval prevents restore and records denial', async t => {
  const authority = enterpriseAuthority();
  const f = await fixture(t, { access: authority.access, organizationId: 'acme' });
  const prepared = await (await f.upload(f.store.backup())).json();
  authority.onFinalCheck(async () => authority.revoke());
  assert.equal((await f.restore(prepared)).status, 403);
  assert.equal(f.store.snapshot().generation, 0);
  assert.ok(f.store.responsibility().records.some(row => row.operation === 'backup.restore' && row.outcome === 'denied'));
});

function barrier() {
  let arrive, release;
  return { reached: new Promise(resolve => { arrive = resolve; }), wait: new Promise(resolve => { release = resolve; }),
    arrive: () => arrive(), release: () => release() };
}
function write(store, command) {
  const { generation, revision } = store.overview();
  return store.execute({ generation, revision, commandId: `search-${generation}-${revision}`, command });
}
function searchContact(name) {
  return { id: 'one', name, company: '', stage: 'lead', nextAction: '', nextActionDate: null };
}
function seedSearch(store, marker) {
  write(store, { type: 'contact.upsert', contact: searchContact(marker) });
  write(store, { type: 'item.upsert', item: { id: `line-${marker}`, sku: marker, name: marker, stock: 12, reorderAt: 3, supplier: '' } });
  write(store, { type: 'order.save', order: { id: 'order', kind: 'sale', counterparty: 'Buyer', orderDate: '2026-09-17', currency: 'CNY', lines: [{ itemId: `line-${marker}`, quantity: 2, unitPriceMinorUnits: 100 }], note: `order-${marker}` } });
}
function searchCount(store, collection, search) {
  return store.queryPage({ collection, search, offset: 0, limit: 10 }, 65536).total;
}
function assertSearch(store, marker, present) {
  for (const collection of ['contacts', 'inventory', 'orders', 'audit']) {
    assert.equal(searchCount(store, collection, marker) > 0, present, `${collection}: ${marker}`);
  }
  for (const search of [`line-${marker}`, `order-${marker}`]) {
    assert.equal(searchCount(store, 'orders', search) > 0, present, `orders: ${search}`);
  }
}
function assertIncrementalContactSearch(store) {
  write(store, { type: 'contact.upsert', contact: searchContact('incrementalinsert') });
  assert.equal(searchCount(store, 'contacts', 'incrementalinsert'), 1);
  write(store, { type: 'contact.upsert', contact: searchContact('incrementalupdate') });
  assert.equal(searchCount(store, 'contacts', 'incrementalinsert'), 0);
  assert.equal(searchCount(store, 'contacts', 'incrementalupdate'), 1);
  write(store, { type: 'contact.remove', id: 'one' });
  assert.equal(searchCount(store, 'contacts', 'incrementalupdate'), 0);
}
test('bulk restore replaces every search index atomically while existing WAL readers retain their snapshot', { timeout: 20000 }, async t => {
  const donor = await fixture(t); seedSearch(donor.store, 'restoredneedle');
  const authority = enterpriseAuthority();
  const f = await fixture(t, { access: authority.access, organizationId: 'acme' });
  seedSearch(f.store, 'currentneedle');
  const prepared = await (await f.upload(donor.store.backup())).json();
  const gate = barrier();
  const reader = new DatabaseSync(f.store.backupDatabasePath());
  const indexedNames = () => reader.prepare('SELECT name FROM contacts WHERE rowid IN (SELECT rowid FROM contacts_search WHERE contacts_search MATCH ?)').all('currentneedle').map(row => row.name);
  authority.onFinalCheck(async index => { if (index === 2) { gate.arrive(); await gate.wait; } });
  let response;
  try {
    reader.exec('BEGIN');
    assert.deepEqual(indexedNames(), ['currentneedle']);
    response = f.restore(prepared, { expectedRevision: f.store.overview().revision });
    await gate.reached;
    assertSearch(f.store, 'currentneedle', true);
    assertSearch(f.store, 'restoredneedle', false);
    gate.release();
    const restored = await response;
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.deepEqual(indexedNames(), ['currentneedle'], 'an already open read transaction keeps its old index snapshot');
    reader.exec('COMMIT');
    assert.deepEqual(indexedNames(), []);
    assertSearch(f.store, 'restoredneedle', true);
    assertSearch(f.store, 'currentneedle', false);
    assertIncrementalContactSearch(f.store);
  } finally {
    gate.release();
    if (response) await response;
    reader.close();
  }
});
test('insertion failure restores the old search indexes and their incremental triggers', async t => {
  const donor = await fixture(t); seedSearch(donor.store, 'restoredneedle');
  const f = await fixture(t); seedSearch(f.store, 'currentneedle');
  const prepared = await (await f.upload(donor.store.backup())).json();
  const db = new DatabaseSync(f.store.backupDatabasePath());
  try {
    db.exec("CREATE TRIGGER reject_search_restore BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
    const before = f.store.snapshot();
    assert.equal((await f.restore(prepared, { expectedRevision: before.revision })).status, 503);
    assert.deepEqual(f.store.snapshot(), before);
    assertSearch(f.store, 'currentneedle', true);
    assertSearch(f.store, 'restoredneedle', false);
    db.exec('DROP TRIGGER reject_search_restore');
    assertIncrementalContactSearch(f.store);
  } finally { db.close(); }
});
test('cancel at final authority check waits for worker rollback before accepting another write', async t => {
  const authority = enterpriseAuthority(); const f = await fixture(t, { access: authority.access, organizationId: 'acme' });
  seedSearch(f.store, 'currentneedle');
  const prepared = await (await f.upload(f.store.backup())).json();
  const gate = barrier(); const controller = new AbortController();
  authority.onFinalCheck(async index => { if (index === 2) { gate.arrive(); await gate.wait; } });
  const before = f.store.snapshot();
  const response = f.restore(prepared, { expectedRevision: before.revision }, controller.signal);
  await gate.reached;
  controller.abort(new Error('operator cancelled'));
  assert.equal((await response).status, 503);
  assert.deepEqual(f.store.snapshot(), before);
  assertSearch(f.store, 'currentneedle', true);
  assertIncrementalContactSearch(f.store);
  const independent = new DatabaseSync(f.store.backupDatabasePath());
  try { independent.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK;'); } finally { independent.close(); }
  assert.ok(f.store.responsibility().records.some(row => row.operation === 'backup.restore' && row.outcome === 'cancelled'));
  gate.release();
  assert.equal((await f.restore(prepared)).status, 400);
});
test('membership revoked while worker holds transaction prevents final COMMIT', async t => {
  const authority = enterpriseAuthority(); const f = await fixture(t, { access: authority.access, organizationId: 'acme' });
  const donor = await fixture(t); seedSearch(donor.store, 'restoredneedle');
  seedSearch(f.store, 'currentneedle');
  const prepared = await (await f.upload(donor.store.backup())).json();
  authority.onFinalCheck(async index => { if (index === 2) authority.revoke(); });
  const before = f.store.snapshot();
  assert.equal((await f.restore(prepared, { expectedRevision: before.revision })).status, 403);
  assert.deepEqual(f.store.snapshot(), before);
  assertSearch(f.store, 'currentneedle', true);
  assertSearch(f.store, 'restoredneedle', false);
  assertIncrementalContactSearch(f.store);
});
test('late insertion failure rolls back imported records and leaves no success receipt', async t => {
  const f = await fixture(t); const prepared = await (await f.upload(f.store.backup())).json();
  const db = new DatabaseSync(f.store.backupDatabasePath());
  db.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON contacts BEGIN SELECT RAISE(ABORT, 'fixture'); END;"); db.close();
  const before = f.store.snapshot();
  assert.equal((await f.restore(prepared)).status, 503);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal((await f.restore(prepared)).status, 400);
  assert.equal(f.store.responsibility().records.filter(row => row.operation === 'backup.restore' && row.outcome === 'succeeded').length, 0);
});
test('disposal cancels a waiting upload without waiting for the sender and leaves storage usable', async t => {
  const f = await fixture(t); const gate = barrier();
  let cancelled = false;
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; }, pull() { gate.arrive(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const response = f.fetch('/backup/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' });
  await gate.reached;
  await f.dispose();
  assert.equal((await response).status, 503);
  assert.equal(body.locked, true); assert.equal(cancelled, false, 'the carrier retains its socket until the refusal is sent');
  controller.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(body.locked, false, 'the reader lock releases after the transport settles its outstanding read');
  assert.equal(f.store.snapshot().generation, 0); assert.equal(f.routes.size, 0);
});
test('expired prepared files fail before target writes and concurrent jobs respect configured capacity', async t => {
  const f = await fixture(t, { config: { preparedTtlMs: 1 } });
  const prepared = await (await f.upload(f.store.backup())).json();
  // A real later I/O round trip allows the configured expiry timer to execute.
  const backup = await f.fetch('/backup'); await backup.arrayBuffer();
  assert.equal((await f.restore(prepared)).status, 400);
  const gate = barrier(); const abort = new AbortController();
  const body = new ReadableStream({ pull() { gate.arrive(); } }, { highWaterMark: 0 });
  const first = f.fetch('/backup/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half', signal: abort.signal });
  await gate.reached;
  assert.equal((await f.fetch('/backup')).status, 503);
  abort.abort(); assert.equal((await first).status, 503);
});

test('restore envelope uploads claim a job before reading a body or opening another staging file', async t => {
  const f = await fixture(t, { config: { maxConcurrentJobs: 1 } });
  const gate = barrier(); const controller = new AbortController();
  t.after(() => controller.abort(new Error('fixture cleanup')));
  const slow = new ReadableStream({ pull() { gate.arrive(); } }, { highWaterMark: 0 });
  const first = f.fetch('/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: slow, duplex: 'half', signal: controller.signal });
  await gate.reached;
  let secondPulls = 0;
  const second = new ReadableStream({ pull(stream) { secondPulls++; stream.enqueue(new TextEncoder().encode('{}')); stream.close(); } }, { highWaterMark: 0 });
  const rejected = await f.fetch('/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: second, duplex: 'half' });
  assert.equal(rejected.status, 503);
  assert.equal(secondPulls, 0);
  controller.abort(new Error('operator cancelled'));
  assert.equal((await first).status, 503);
  assert.equal(f.store.overview().generation, 0);
});
test('a worker heap limit rejects an import without exiting the Host or changing its database', async t => {
  const f = await fixture(t, { config: { workerHeapMb: 32, workerYoungHeapMb: 4 } });
  const backup = f.store.backup();
  const template = backup.snapshot.contacts[0];
  const count = 4000;
  backup.snapshot.revision = count; backup.snapshot.contacts = []; backup.snapshot.audit = []; backup.auditCommands = [];
  for (let index = 0; index < count; index++) {
    const contact = { ...template, id: `memory-${index}`, nextAction: 'x'.repeat(2000) };
    const { updatedAt: _at, ...input } = contact;
    const revision = count - index;
    backup.snapshot.contacts.push(contact);
    backup.snapshot.audit.push({ revision, commandId: `memory-${index}`, entityId: contact.id, at: template.updatedAt, type: 'contact.upsert', before: null, after: contact });
    backup.auditCommands.push({ revision, commandId: `memory-${index}`, commandJson: JSON.stringify({ type: 'contact.upsert', contact: input }) });
  }
  const before = f.store.snapshot();
  const response = await f.upload(backup);
  assert.equal(response.status, 503, await response.clone().text());
  assert.match((await response.json()).error.message, /heap limit/);
  assert.deepEqual(f.store.snapshot(), before);
  const probe = new DatabaseSync(f.store.backupDatabasePath());
  try { probe.exec('BEGIN IMMEDIATE; ROLLBACK;'); } finally { probe.close(); }
});
test('a configured operation timeout cancels an idle upload and releases its reserved job', async t => {
  // Keep enough time for the immediate filesystem-backed retry on slow CI hosts.
  const f = await fixture(t, { config: { timeoutMs: 1000 } });
  const body = new ReadableStream({ pull() {} }, { highWaterMark: 0 });
  const response = await f.fetch('/backup/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' });
  assert.equal(response.status, 503);
  assert.equal(f.store.snapshot().generation, 0);
  assert.ok(f.store.responsibility().records.some(row => row.operation === 'backup.prepare' && row.outcome === 'cancelled'));
  const retry = await f.fetch('/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(retry.status, 400, await retry.clone().text());
  assert.equal((await retry.json()).error.code, 'invalid_request', 'The timed-out upload must release the backup job before its body source settles.');
});
for (const path of ['', '/backup/prepare']) test(`disposal cancels unresolved identity for ${path || 'ordinary overview'} without accessing closed storage`, async t => {
  const gate = barrier();
  const authority = {
    async http() { gate.arrive(); await gate.wait; return { organizationId: 'acme', memberId: 'admin', actor: 'human' }; },
    async agent() { return undefined; }, async membership() { throw new Error('Cancelled resolution must not query membership.'); },
    async consumeApproval() { throw new Error('Cancelled resolution must not approve.'); },
  };
  const f = await fixture(t, { access: new GovernanceAccess({ mode: 'enterprise', organizationId: 'acme', authority }), organizationId: 'acme' });
  const response = f.fetch(path, path ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : undefined);
  await gate.reached;
  await f.dispose();
  assert.equal((await response).status, 503);
  gate.release();
  assert.equal(f.routes.size, 0);
});
