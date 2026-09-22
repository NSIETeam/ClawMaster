/** Query-plan evidence for enterprise search: an FTS index serves the candidates and the JS predicate cannot. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEnterpriseStore } from '../src/enterprise-host.ts';

/** Plan rows for one statement, joined so a failure prints what SQLite decided. */
function planOf(db, sql) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => String(row.detail)).join(' | ');
}

/** Open a freshly created store, keep its schema, and return a read-only query planner for it. */
async function plannedStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-search-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, 'enterprise.sqlite');
  const store = await openEnterpriseStore(databasePath);
  store.close();
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  // The exact-match predicate is registered by the store; a plan only needs it to exist, at the store's arity.
  db.function('clawmaster_contains', { deterministic: true }, (value, search) => (typeof value === 'string' && typeof search === 'string' ? 1 : 0));
  return db;
}

test('the committed schema builds an FTS5 trigram index for the searched collections', async t => {
  const db = await plannedStore(t);
  // Names come from the search statement itself: a collection uses `<collection>_search`, while
  // audit and order lines use `audit_search` and `orderLines_search`.
  for (const collection of ['contacts', 'inventory', 'orders', 'audit', 'orderLines']) {
    const row = db.prepare('SELECT type, sql FROM sqlite_master WHERE name = ?').get(`${collection}_search`);
    assert.ok(row, `${collection}_search exists`);
    assert.equal(String(row.type), 'table');
    assert.match(String(row.sql), /USING fts5\(/i, `${collection}_search is an FTS5 virtual table`);
    assert.match(String(row.sql), /tokenize\s*=\s*'trigram'/i, `${collection}_search tokenizes by trigram`);
  }
});

test('the search candidate query reads the index instead of scanning the record table', async t => {
  const db = await plannedStore(t);
  const plan = planOf(db, "SELECT rowid FROM contacts_search WHERE contacts_search MATCH 'acme'");
  assert.match(plan, /contacts_search/, 'the plan reads the search index');
  assert.doesNotMatch(plan, /SCAN contacts\b/, 'the plan does not scan the record table');
});

test('the exact-match predicate is applied to rows and cannot use an index', async t => {
  const db = await plannedStore(t);
  const plan = planOf(db, "SELECT r.id FROM contacts r WHERE clawmaster_contains(COALESCE(r.name, ''), 'acme') = 1");
  assert.match(plan, /SCAN/, 'a JavaScript predicate forces a scan of the rows it inspects');
});

test('the shipped search shape combines the index with the predicate', async t => {
  const db = await plannedStore(t);
  const plan = planOf(db, `SELECT r.id FROM contacts r
    WHERE (r.rowid IN (SELECT rowid FROM contacts_search WHERE contacts_search MATCH 'acme'))
      AND (clawmaster_contains(COALESCE(r.name, ''), 'acme') = 1
        OR clawmaster_contains(COALESCE(r.company, ''), 'acme') = 1)`);
  assert.match(plan, /contacts_search/, 'the index still supplies the candidate set');
  assert.match(plan, /SCAN/, 'the predicate is still evaluated per candidate row');
});
