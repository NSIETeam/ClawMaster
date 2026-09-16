/** Exercise the registered HTTP handlers and persisted SQLite state, not a copied page builder. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { EnterpriseStore, mountEnterpriseRoutes, openEnterpriseStore } from '../src/enterprise-host.ts';
import { parseEnterpriseOverview, parseEnterprisePage, parseEnterpriseReceipt } from '../src/enterprise-schema.ts';

const base = '/api/clawmaster/enterprise';
const contact = (id, extra = {}) => ({ id, name: '同名', company: 'ÉCOLE % _', stage: 'proposal', nextAction: '复核报价', nextActionDate: '2026-01-01', ...extra });
async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-pages-'));
  const path = join(root, 'records.sqlite');
  const store = await openEnterpriseStore(path, 5000, 'local', {}, config);
  const routes = new Map();
  const remove = await mountEnterpriseRoutes({ connection: { fetch: { register(route) {
    routes.set(route.path, route.fetch); return async () => { routes.delete(route.path); };
  } } } }, store);
  t.after(async () => { await remove(); store.close(); await rm(root, { recursive: true, force: true }); });
  const fetch = async (suffix = '', init) => {
    const request = new Request(`http://fixture${base}${suffix}`, init);
    return routes.get(new URL(request.url).pathname)(request);
  };
  const write = async (id, fields = {}, version = store.overview(), commandId = `command-${version.revision + 1}`) => {
    const body = { generation: version.generation, revision: version.revision, commandId, command: { type: 'contact.upsert', contact: contact(id, fields) } };
    return fetch('/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };
  const page = (value = {}) => fetch(`/query?${new URLSearchParams({ collection: 'contacts', offset: '0', limit: '3', ...value })}`);
  return { store, path, root, fetch, write, page, remove };
}

test('manual overview, filtered pages and saved receipts stay bounded as audit history grows', async t => {
  const f = await fixture(t, { maxPageRows: 3, maxPageBytes: 4096 });
  const first = parseEnterpriseReceipt(await (await f.write('contact-0')).json());
  for (let i = 0; i < 250; i++) assert.equal((await f.write(`contact-${i % 8}`, { nextAction: `Review ${i}` })).status, 200);
  const overviewResponse = await f.fetch();
  const overviewText = await overviewResponse.text();
  const overview = parseEnterpriseOverview(JSON.parse(overviewText));
  assert.equal(overview.counts.contacts, 8);
  assert.equal(overview.counts.audit, 251);
  assert.ok(Buffer.byteLength(overviewText) < 400);
  assert.deepEqual(Object.keys(overview).sort(), ['counts', 'generation', 'limits', 'revision']);
  const finalResponse = await f.write('contact-0');
  const finalText = await finalResponse.text();
  const final = parseEnterpriseReceipt(JSON.parse(finalText));
  assert.equal(final.commandRevision, 252);
  assert.deepEqual(Object.keys(final), Object.keys(first));
  assert.ok(Buffer.byteLength(finalText) < 400);
  assert.ok(Buffer.byteLength(JSON.stringify(f.store.snapshot())) > 100_000);
  const result = parseEnterprisePage(await (await f.page({ search: 'École % _' })).json());
  assert.equal(result.total, 8);
  assert.equal(result.records.length, 3);
  assert.equal((await f.page({ limit: '4' })).status, 400);
});

test('versioned pages preserve ordering and reject missing versions, edits and restores', async t => {
  const f = await fixture(t, { maxPageRows: 3 });
  for (const id of ['d', 'c', 'b', 'a', 'z']) await f.write(id);
  const first = parseEnterprisePage(await (await f.page()).json());
  assert.deepEqual(first.records.map(row => row.id), ['a', 'b', 'c']);
  const version = { generation: String(first.generation), revision: String(first.revision) };
  assert.equal((await f.page({ offset: '3' })).status, 400);
  assert.equal((await f.page({ offset: '3', revision: version.revision })).status, 400);
  const second = parseEnterprisePage(await (await f.page({ offset: '3', ...version })).json());
  assert.deepEqual(second.records.map(row => row.id), ['d', 'z']);
  assert.equal(second.nextOffset, null);
  assert.equal((await f.page({ id: 'a', ...version })).status, 200);
  await f.write('aa');
  assert.equal((await f.page({ offset: '3', ...version })).status, 409);
  const beforeRestore = f.store.overview();
  f.store.restore(f.store.backup(), beforeRestore.revision, beforeRestore.generation);
  const stale = await f.page({ offset: '3', revision: String(beforeRestore.revision), generation: String(beforeRestore.generation) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'revision_conflict');
});

test('server filters apply before pagination and do not interpret SQL, JSON names or wildcards', async t => {
  const f = await fixture(t);
  await f.write('a', { stage: 'won' });
  await f.write('b', { nextActionDate: '2026-09-30' });
  await f.write('c');
  const due = parseEnterprisePage(await (await f.page({ stage: 'proposal', dueBefore: '2026-09-16' })).json());
  assert.deepEqual(due.records.map(row => row.id), ['c']);
  for (const search of ['"name":', "' OR 1=1 --"]) {
    assert.equal((await (await f.page({ search })).json()).total, 0);
  }
  assert.equal((await (await f.page({ search: '% _' })).json()).total, 3);
  for (const value of [{ collection: 'audit', stage: 'won' }, { collection: 'orders', lowStock: 'true' }, { offset: '-1' }, { limit: '1.2' }, { lowStock: 'maybe' }]) {
    assert.equal((await f.page(value)).status, 400);
  }
  assert.equal((await f.fetch('/query?collection=contacts&offset=0&limit=1&limit=2')).status, 400);
});

test('UTF-8 page limits retain whole rows and an oversized new audit record rolls back the write', async t => {
  const f = await fixture(t, { maxPageBytes: 1024 });
  await f.write('short');
  const before = f.store.snapshot();
  const rejected = await f.write('wide', { nextAction: '😀'.repeat(500) });
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json()).error.code, 'result_too_large');
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.store.responsibility().records.at(-1).reasonCode, 'result_too_large');
  for (let i = 0; i < 6; i++) assert.equal((await f.write(`n-${i}`, { nextAction: '😀'.repeat(20) })).status, 200);
  let offset = 0;
  const version = f.store.overview();
  const ids = [];
  do {
    const response = await f.page({ offset: String(offset), generation: String(version.generation), revision: String(version.revision), limit: '3' });
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= 1024);
    const page = parseEnterprisePage(JSON.parse(text));
    ids.push(...page.records.map(row => row.id));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(ids.length, version.counts.contacts);
  assert.equal(new Set(ids).size, ids.length);
});

test('lowering the read budget reports oversized persisted data without rewriting it', async t => {
  const f = await fixture(t, { maxPageBytes: 65536 });
  await f.write('large', { nextAction: '汉'.repeat(2000) });
  const before = f.store.snapshot();
  const narrow = await openEnterpriseStore(f.path, 5000, 'local', {}, { maxPageBytes: 1024 });
  try {
    assert.throws(() => narrow.queryPage({ collection: 'contacts', offset: 0, limit: 1 }, 1024), { code: 'result_too_large' });
    assert.deepEqual(narrow.snapshot(), before);
  } finally { narrow.close(); }
});

test('startup validates records and audit continuity without materializing a full snapshot', async t => {
  const f = await fixture(t);
  await f.write('valid');
  t.mock.method(EnterpriseStore.prototype, 'snapshot', () => { throw new Error('full snapshot called'); });
  const reopened = await openEnterpriseStore(f.path);
  reopened.close();
  const db = new DatabaseSync(f.path);
  db.prepare('UPDATE contacts SET nextActionDate=? WHERE id=?').run('2026-02-31', 'valid');
  db.close();
  await assert.rejects(openEnterpriseStore(f.path), { code: 'storage_invalid' });
  const repair = new DatabaseSync(f.path);
  repair.prepare('UPDATE contacts SET nextActionDate=? WHERE id=?').run('2026-01-01', 'valid');
  repair.exec('UPDATE enterprise_meta SET revision=2');
  repair.close();
  await assert.rejects(openEnterpriseStore(f.path), { code: 'storage_invalid' });
});

test('invalid page configuration is refused before storage creation and cancelled writes stay unchanged', async t => {
  const f = await fixture(t);
  const invalidPath = join(f.root, 'invalid.sqlite');
  await assert.rejects(openEnterpriseStore(invalidPath, 5000, 'local', {}, { maxPageBytes: 1023 }));
  await assert.rejects(access(invalidPath), { code: 'ENOENT' });
  const request = { generation: 0, revision: 0, commandId: 'cancelled', command: { type: 'contact.upsert', contact: contact('cancelled') } };
  const controller = new AbortController(); controller.abort();
  const response = await f.fetch('/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
  assert.equal(response.status, 503);
  assert.equal(f.store.overview().revision, 0);
  assert.equal(f.store.overview().counts.contacts, 0);
});
