import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { appendResponsibility, initializeResponsibilityHistory, LOCAL_HTTP_IDENTITY, queryResponsibility } from '../src/governance-audit.ts';

const wire = (value, transport) => transport === 'http' ? JSON.stringify(value)
  : JSON.stringify({ isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] });
const bytes = (value, transport) => Buffer.byteLength(wire(value, transport), 'utf8');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE enterprise_meta(singleton INTEGER PRIMARY KEY, generation INTEGER);
    INSERT INTO enterprise_meta VALUES(1, 0);
    CREATE TABLE enterprise_audit(revision INTEGER, commandId TEXT, type TEXT, entityId TEXT);`);
  initializeResponsibilityHistory(db);
  const append = (overrides = {}) => appendResponsibility(db, { identity: LOCAL_HTTP_IDENTITY,
    operation: 'record.read', outcome: 'succeeded', generationBefore: 0, generationAfter: 0,
    revisionBefore: 0, revisionAfter: 0, ...overrides });
  return { db, append };
}

test('configured responsibility row limits control omitted and explicit limits', t => {
  const { db, append } = fixture(t);
  const expected = Array.from({ length: 5 }, () => append());
  const limits = { maxRows: 2, maxBytes: 65536 };
  assert.deepEqual(queryResponsibility(db, {}, limits), { records: expected.slice(0, 2), nextAfter: 2 });
  assert.deepEqual(queryResponsibility(db, { limit: 1 }, limits), { records: expected.slice(0, 1), nextAfter: 1 });
  assert.throws(() => queryResponsibility(db, { limit: 3 }, limits), { code: 'invalid_request' });
  assert.deepEqual(queryResponsibility(db, { limit: 501 }, { ...limits, maxRows: 600 }), { records: expected, nextAfter: null });
  for (const query of [{ limit: 0 }, { limit: 1.5 }, { after: -1 }, { after: Number.MAX_SAFE_INTEGER + 1 }, { unexpected: true }]) {
    assert.throws(() => queryResponsibility(db, query, limits), { code: 'invalid_request' });
  }
});

for (const transport of ['http', 'tool']) {
  test(`${transport} responsibility pages account for UTF-8, escaping and continuation without dropping records`, async t => {
    const { db, append } = fixture(t);
    const expected = Array.from({ length: 16 }, (_, index) => append({ commandId: `cmd-${index}`,
      reasonCode: '中😀"\\\n'.repeat(12) }));
    const maxBytes = Math.max(...expected.map(record => bytes({ records: [record], nextAfter: record.sequence }, transport)),
      bytes({ records: [expected.at(-1)], nextAfter: null }, transport));
    const found = [];
    let after = 0;
    do {
      const page = queryResponsibility(db, { after }, { maxRows: 50, maxBytes }, transport);
      assert.equal(page.records.length, 1);
      assert.ok(bytes(page, transport) <= maxBytes);
      if (transport === 'http') assert.ok(Buffer.byteLength(await Response.json(page).text(), 'utf8') <= maxBytes);
      found.push(...page.records);
      if (page.nextAfter === null) break;
      assert.ok(page.nextAfter > after);
      assert.equal(page.nextAfter, page.records.at(-1).sequence);
      after = page.nextAfter;
      assert.ok(found.length < expected.length);
    } while (true);
    assert.deepEqual(found, expected);
  });

  test(`${transport} accepts exact byte budgets including commas, cursor and final null`, t => {
    const { db, append } = fixture(t);
    const expected = Array.from({ length: 3 }, () => append({ reasonCode: '字😀"\\' }));
    const continued = { records: expected.slice(0, 2), nextAfter: 2 };
    const exact = bytes(continued, transport);
    assert.deepEqual(queryResponsibility(db, {}, { maxRows: 2, maxBytes: exact }, transport), continued);
    assert.deepEqual(queryResponsibility(db, {}, { maxRows: 2, maxBytes: exact - 1 }, transport), { records: [expected[0]], nextAfter: 1 });
    const last = { records: [expected[2]], nextAfter: null };
    const finalBytes = bytes(last, transport);
    assert.deepEqual(queryResponsibility(db, { after: 2 }, { maxRows: 2, maxBytes: finalBytes }, transport), last);
    assert.throws(() => queryResponsibility(db, { after: 2 }, { maxRows: 2, maxBytes: finalBytes - 1 }, transport), { code: 'result_too_large' });
    const shortCursorBytes = bytes({ ...last, nextAfter: 3 }, transport);
    assert.ok(shortCursorBytes < finalBytes);
    assert.throws(() => queryResponsibility(db, { after: 2 }, { maxRows: 2, maxBytes: shortCursorBytes }, transport), { code: 'result_too_large' });
  });

  test(`${transport} rejects an oversized record at its own cursor and can resume with a larger budget`, t => {
    const { db, append } = fixture(t);
    const first = append();
    const oversized = append({ reasonCode: '大😀"\\'.repeat(1000) });
    const third = append();
    const limits = { maxRows: 10, maxBytes: bytes({ records: [first], nextAfter: 1 }, transport) };
    assert.deepEqual(queryResponsibility(db, {}, limits, transport), { records: [first], nextAfter: 1 });
    assert.throws(() => queryResponsibility(db, { after: 1 }, limits, transport), { code: 'result_too_large' });
    const rest = { records: [oversized, third], nextAfter: null };
    assert.deepEqual(queryResponsibility(db, { after: 1 }, { ...limits, maxBytes: bytes(rest, transport) }, transport), rest);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM responsibility_history').get().n, 3);
  });

  test(`${transport} empty pages also obey their complete response byte budget`, t => {
    const { db } = fixture(t);
    const empty = { records: [], nextAfter: null };
    const exact = bytes(empty, transport);
    assert.deepEqual(queryResponsibility(db, {}, { maxRows: 1, maxBytes: exact }, transport), empty);
    assert.throws(() => queryResponsibility(db, {}, { maxRows: 1, maxBytes: exact - 1 }, transport), { code: 'result_too_large' });
  });
}

test('all metadata filters retain stable after cursors when new matching records are appended', t => {
  const { db, append } = fixture(t);
  const selected = { identity: { ...LOCAL_HTTP_IDENTITY, actor: { kind: 'member', id: 'selected' } },
    commandId: 'command', entityId: 'record', operation: 'read' };
  const expected = [append(selected)];
  append({ ...selected, identity: LOCAL_HTTP_IDENTITY });
  append({ ...selected, commandId: 'other' });
  expected.push(append(selected));
  append({ ...selected, entityId: 'other' });
  append({ ...selected, operation: 'other' });
  expected.push(append(selected));
  const query = { actorId: 'selected', commandId: 'command', entityId: 'record', operation: 'read' };
  const limits = { maxRows: 2, maxBytes: 65536 };
  const first = queryResponsibility(db, query, limits);
  assert.deepEqual(first, { records: expected.slice(0, 2), nextAfter: 4 });
  expected.push(append(selected));
  const second = queryResponsibility(db, { ...query, after: first.nextAfter }, limits);
  assert.deepEqual(second, { records: expected.slice(2), nextAfter: null });
  assert.deepEqual(queryResponsibility(db, { ...query, after: second.records.at(-1).sequence }, limits), { records: [], nextAfter: null });
});

test('responsibility paging reads only enough SQLite rows to fill a page and one continuation record', t => {
  const { db, append } = fixture(t);
  for (let i = 0; i < 1000; i++) append();
  let observedRows = 0;
  const observed = { prepare(sql) {
    const statement = db.prepare(sql);
    return { all() { throw new Error('History must not materialize every matching record.'); },
      *iterate(...parameters) { for (const row of statement.iterate(...parameters)) { observedRows++; yield row; } } };
  } };
  const page = queryResponsibility(observed, {}, { maxRows: 2, maxBytes: 65536 });
  assert.equal(page.records.length, 2);
  assert.equal(page.nextAfter, 2);
  assert.equal(observedRows, 3);
});

test('tool responsibility byte budgets match a real DSH structured result and rendered content', async t => {
  const { db, append } = fixture(t);
  const records = Array.from({ length: 3 }, () => append({ reasonCode: '中😀"\\\n'.repeat(10) }));
  const expected = { records: records.slice(0, 2), nextAfter: 2 };
  let maxBytes = bytes(expected, 'tool');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  ctx.tools.register({ name: 'responsibility_capacity_probe', description: 'Read the isolated test database.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: () => queryResponsibility(db, {}, { maxRows: 2, maxBytes }, 'tool') });
  const execute = callId => ctx.tools.execute({ callId, name: 'responsibility_capacity_probe', arguments: {}, signal: new AbortController().signal });
  const exact = await execute('exact');
  assert.equal(exact.isError, false);
  assert.deepEqual(exact.value, expected);
  assert.deepEqual(JSON.parse(exact.content[0].text), exact.value);
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), maxBytes);
  maxBytes--;
  const smaller = await execute('smaller');
  assert.equal(smaller.isError, false);
  assert.deepEqual(smaller.value, { records: [records[0]], nextAfter: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(smaller), 'utf8') <= maxBytes);
});
