import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { applyEnterpriseTools } from '../src/enterprise-tools.ts';
import { openEnterpriseStore } from '../src/enterprise-host.ts';

const contact = { id: 'crm-1', name: '王经理', company: '远航科技', stage: 'proposal', nextAction: '确认报价', nextActionDate: null };
const item = { id: 'item-1', sku: 'A-001', name: '控制器', stock: 12, reorderAt: 3, supplier: '本地供应商' };
const order = { id: 'order-1', kind: 'sale', counterparty: '远航科技', orderDate: '2026-09-12', currency: 'CNY', lines: [{ itemId: item.id, quantity: 2, unitPriceMinorUnits: 12345 }], note: '' };
const resultText = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('');
const request = (store, command, extra = {}) => ({ generation: store.snapshot().generation, revision: store.snapshot().revision, commandId: randomUUID(), command, ...extra });

async function setup(t, options = {}, policy = 'ask') {
  const ctx = new Context();
  const store = await openEnterpriseStore(':memory:');
  let dispose = async () => {};
  t.after(async () => {
    try { await dispose(); await ctx.fiber.dispose(); }
    finally { store.close(); }
  });
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy }).await();
  dispose = await applyEnterpriseTools(ctx, store, options);
  const session = Session.create(SessionId(randomUUID()));
  session.append('turn/start', { turn: 1 });
  // Approval and tool dispatch consume this real Session; no model runs in this unit fixture.
  const agent = { id: session.id, session };
  const execute = (name, args, signal = new AbortController().signal) => ctx.tools.execute({
    callId: randomUUID(), name, arguments: args, agent, signal,
  });
  const command = value => execute('enterprise_command', { request: request(store, value) });
  return { ctx, store, session, execute, command, dispose };
}

function seed(store) {
  for (const command of [{ type: 'contact.upsert', contact }, { type: 'item.upsert', item }, { type: 'order.save', order }]) {
    store.execute(request(store, command));
  }
}

test('approved CRM and draft commands use shared transactions and queries expose only a filtered page', async t => {
  const h = await setup(t, { maxQueryRows: 2 });
  let approvals = 0;
  h.ctx.on('approval/request', async () => { approvals++; return 'allowed-once'; });
  for (let i = 0; i < 3; i++) {
    const result = await h.command({ type: 'contact.upsert', contact: { ...contact, id: `crm-${i}`, name: `客户${i}` } });
    assert.equal(result.isError, false, resultText(result));
    assert.equal(result.value.commandRevision, i + 1);
    assert.deepEqual(JSON.parse(resultText(result)), result.value);
  }
  assert.equal(approvals, 3);
  const first = await h.execute('enterprise_query', { collection: 'contacts', search: '远航', offset: 0, limit: 2 });
  assert.equal(first.isError, false, resultText(first));
  assert.deepEqual(Object.keys(first.value).sort(), ['collection', 'generation', 'nextOffset', 'offset', 'records', 'revision', 'total']);
  assert.equal(first.value.records.length, 2);
  assert.equal(first.value.nextOffset, 2);
  assert.equal(first.value.total, 3);
  assert.deepEqual(JSON.parse(resultText(first)), first.value);
  const second = await h.execute('enterprise_query', { collection: 'contacts', offset: 2, limit: 2, revision: first.value.revision, generation: first.value.generation });
  assert.equal(second.value.records.length, 1);
  assert.equal(second.value.nextOffset, null);
  const exact = await h.execute('enterprise_query', { collection: 'contacts', id: 'crm-1', offset: 0, limit: 1 });
  assert.deepEqual(exact.value.records.map(row => row.id), ['crm-1']);
  const audit = await h.execute('enterprise_query', { collection: 'audit', id: 'crm-1', offset: 0, limit: 1 });
  assert.equal(audit.value.records[0].after.id, 'crm-1');
  assert.equal(audit.value.records[0].before, null);
  assert.equal((await h.execute('enterprise_query', { collection: 'inventory', offset: 0, limit: 1 })).value.total, 0);
  h.store.execute(request(h.store, { type: 'item.upsert', item }));
  const draft = await h.command({ type: 'order.save', order });
  assert.equal(draft.isError, false, resultText(draft));
  assert.equal((await h.execute('enterprise_query', { collection: 'orders', offset: 0, limit: 1 })).value.records[0].status, 'draft');
  assert.equal(approvals, 4);
  const stale = await h.execute('enterprise_query', { collection: 'contacts', offset: 2, limit: 2, revision: first.value.revision, generation: first.value.generation });
  assert.equal(stale.isError, true);
  assert.match(resultText(stale), /revision_conflict/);
  assert.equal((await h.execute('enterprise_query', { collection: 'contacts', offset: 0, limit: 3 })).isError, true);
});

test('tool schemas and the HTTP domain parser reject extra, malformed and unsafe fields before approval', async t => {
  const h = await setup(t);
  let asked = 0;
  h.ctx.on('approval/request', async () => { asked++; return 'allowed-once'; });
  for (const tool of h.ctx.tools.schemas()) assert.equal(tool.parameters.additionalProperties, false);
  const invalid = [
    { request: request(h.store, { type: 'contact.upsert', contact }), extra: true },
    { request: request(h.store, { type: 'contact.upsert', contact: { ...contact, unexpected: true } }) },
    { request: request(h.store, { type: 'contact.upsert', contact: { ...contact, nextActionDate: '2026-02-30' } }) },
    { request: request(h.store, { type: 'item.upsert', item: { ...item, stock: -1 } }) },
    { request: request(h.store, { type: 'order.save', order: { ...order, lines: [{ ...order.lines[0], quantity: 0 }] } }) },
    { request: request(h.store, { type: 'contact.remove', id: contact.id, approved: true }) },
  ];
  for (const args of invalid) {
    const result = await h.execute('enterprise_command', args);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /invalid_request/);
  }
  for (const extra of [{ offset: -1 }, { limit: 0 }, { extra: true }]) {
    assert.equal((await h.execute('enterprise_query', { collection: 'contacts', offset: 0, limit: 1, ...extra })).isError, true);
  }
  assert.equal(asked, 0);
  assert.equal(h.store.snapshot().revision, 0);
});

test('model tool schemas preserve restore generations and permit a newly reviewed post-restore command', async t => {
  const h = await setup(t);
  const schemas = h.ctx.tools.schemas();
  const commandSchema = schemas.find(schema => schema.name === 'enterprise_command').parameters.properties.request;
  assert.equal(commandSchema.properties.generation.type, 'integer');
  assert.ok(commandSchema.required.includes('generation'));
  const querySchema = schemas.find(schema => schema.name === 'enterprise_query').parameters;
  assert.equal(querySchema.properties.generation.type, 'integer');
  assert.equal(querySchema.additionalProperties, false);
  h.ctx.on('approval/request', async () => 'allowed-once');
  const backup = h.store.backup();
  h.store.restore(backup, 0, 0);
  const page = await h.execute('enterprise_query', { collection: 'contacts', generation: 1, revision: 0, offset: 0, limit: 10 });
  assert.equal(page.isError, false, resultText(page));
  assert.equal(page.value.generation, 1);
  const changed = await h.command({ type: 'contact.upsert', contact });
  assert.equal(changed.isError, false, resultText(changed));
  assert.equal(changed.value.generation, 1);
  const stale = await h.execute('enterprise_query', { collection: 'contacts', generation: 0, revision: 1, offset: 0, limit: 10 });
  assert.equal(stale.isError, true);
  assert.match(resultText(stale), /revision_conflict/);
});

test('every business mutation fails closed without an approval answerer', async t => {
  const h = await setup(t);
  seed(h.store);
  const before = h.store.snapshot();
  for (const command of [
    { type: 'contact.upsert', contact: { ...contact, stage: 'lost' } },
    { type: 'order.save', order: { ...order, note: 'changed without approval' } },
    { type: 'item.upsert', item: { ...item, stock: 20 } },
    { type: 'contact.remove', id: contact.id },
    { type: 'item.remove', id: item.id },
    { type: 'order.remove', id: order.id },
    { type: 'order.submit', id: order.id },
  ]) {
    const result = await h.command(command);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /approval_unavailable/);
    assert.deepEqual(h.store.snapshot(), before);
  }
  assert.deepEqual(h.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome), Array(7).fill('unavailable'));
});

test('one-shot approval records the exact reviewed action and an idempotent retry does not repeat it', async t => {
  const h = await setup(t);
  seed(h.store);
  const seen = [];
  h.ctx.on('approval/request', async event => { seen.push(event); return 'allowed-once'; });
  const envelope = { request: request(h.store, { type: 'order.submit', id: order.id }) };
  const submitted = await h.execute('enterprise_command', envelope);
  assert.equal(submitted.isError, false, resultText(submitted));
  assert.equal(h.store.snapshot().inventory[0].stock, 10);
  assert.equal(seen.length, 1);
  assert.match(seen[0].reason, /"unitPriceMinorUnits":12345/);
  assert.match(seen[0].reason, /"stock":12/);
  assert.equal(seen[0].toolName, 'enterprise_command');
  const decisions = h.session.snapshotEvents().filter(event => event.type.startsWith('approval/'));
  assert.equal(decisions[0].type, 'approval/asked');
  assert.equal(decisions[1].data.outcome, 'allowed-once');
  assert.equal(decisions[0].data.id, decisions[1].data.id);
  const replay = await h.execute('enterprise_command', envelope);
  assert.deepEqual(replay.value, submitted.value);
  assert.equal(seen.length, 1);
  assert.equal(h.store.snapshot().inventory[0].stock, 10);
  const conflict = await h.execute('enterprise_command', { request: { ...envelope.request, command: { type: 'contact.remove', id: contact.id } } });
  assert.equal(conflict.isError, true);
  assert.match(resultText(conflict), /command_conflict/);
  assert.equal(seen.length, 1);
  const next = await h.command({ type: 'item.upsert', item: { ...item, stock: 11 } });
  assert.equal(next.isError, false, resultText(next));
  assert.equal(seen.length, 2);
});

for (const outcome of ['rejected', 'cancelled']) {
  test(`approval outcome ${outcome} leaves the database unchanged`, async t => {
    const h = await setup(t);
    seed(h.store);
    const before = h.store.snapshot();
    h.ctx.on('approval/request', async () => outcome);
    const result = await h.command({ type: 'order.submit', id: order.id });
    assert.equal(result.isError, true);
    assert.match(resultText(result), new RegExp(`approval_${outcome}`));
    assert.deepEqual(h.store.snapshot(), before);
  });
}

test('restore during approval rejects the old reviewed command even when the revision repeats', async t => {
  const h = await setup(t);
  seed(h.store);
  const backup = h.store.backup();
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  h.ctx.on('approval/request', () => { entered.resolve(); return answer.promise; });
  const pending = h.command({ type: 'order.submit', id: order.id });
  await entered.promise;
  h.store.restore(backup, backup.snapshot.revision, 0);
  answer.resolve('allowed-once');
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(resultText(result), /revision_conflict/);
  assert.equal(h.store.snapshot().orders[0].status, 'draft');
  assert.equal(h.store.snapshot().inventory[0].stock, item.stock);
  const page = await h.execute('enterprise_query', { collection: 'orders', offset: 0, limit: 10, revision: backup.snapshot.revision, generation: 0 });
  assert.equal(page.isError, true);
});

test('never policy rejects before an answerer can grant permission', async t => {
  const h = await setup(t, {}, 'never');
  seed(h.store);
  let answered = false;
  h.ctx.on('approval/request', async () => { answered = true; return 'allowed-once'; });
  const result = await h.command({ type: 'order.submit', id: order.id });
  assert.equal(result.isError, true);
  assert.equal(answered, false);
  assert.equal(h.store.snapshot().orders[0].status, 'draft');
});

test('an edit during approval makes the reviewed command stale instead of changing stock', { timeout: 30000 }, async t => {
  const h = await setup(t);
  seed(h.store);
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  h.ctx.on('approval/request', () => { entered.resolve(); return answer.promise; });
  const pending = h.command({ type: 'order.submit', id: order.id });
  await entered.promise;
  h.store.execute(request(h.store, { type: 'contact.upsert', contact: { ...contact, stage: 'won' } }));
  const afterEdit = h.store.snapshot();
  answer.resolve('allowed-once');
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(resultText(result), /revision_conflict/);
  assert.deepEqual(h.store.snapshot(), afterEdit);
});

test('unload withdraws tools and drains cancelled approval before the store is closed', { timeout: 30000 }, async t => {
  const h = await setup(t);
  seed(h.store);
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  h.ctx.on('approval/request', () => { entered.resolve(); return answer.promise; });
  const before = h.store.snapshot();
  const pending = h.command({ type: 'order.submit', id: order.id });
  await entered.promise;
  await h.dispose();
  assert.equal((await pending).isError, true);
  assert.equal(h.ctx.tools.get('enterprise_command'), undefined);
  assert.equal(h.ctx.tools.get('enterprise_query'), undefined);
  answer.resolve('allowed-once');
  await Promise.resolve();
  assert.deepEqual(h.store.snapshot(), before);
  assert.equal(h.session.snapshotEvents().findLast(event => event.type === 'approval/decided').data.outcome, 'cancelled');
});

test('query byte limits paginate whole records and report a single oversized record', async t => {
  const h = await setup(t, { maxQueryBytes: 1024 });
  for (let i = 0; i < 3; i++) h.store.execute(request(h.store, { type: 'contact.upsert', contact: { ...contact, id: `record-${i}`, name: `Record ${i}`, nextAction: 'x'.repeat(500) } }));
  const result = await h.execute('enterprise_query', { collection: 'contacts', offset: 0, limit: 3 });
  assert.equal(result.isError, false, resultText(result));
  assert.equal(result.value.records.length, 1);
  assert.equal(result.value.nextOffset, 1);
  assert.ok(Buffer.byteLength(resultText(result)) <= 1024);
  h.store.execute(request(h.store, { type: 'contact.upsert', contact: { ...contact, id: 'oversized', nextAction: 'x'.repeat(2000) } }));
  const oversized = await h.execute('enterprise_query', { collection: 'contacts', id: 'oversized', offset: 0, limit: 1 });
  assert.equal(oversized.isError, true);
  assert.match(resultText(oversized), /result_too_large/);
});

test('Host presenters replay from arguments and recorded content without reading storage', async t => {
  const h = await setup(t);
  h.ctx.on('approval/request', async () => 'allowed-once');
  const result = await h.command({ type: 'contact.upsert', contact });
  const query = h.ctx.tools.get('enterprise_query');
  const change = h.ctx.tools.get('enterprise_command');
  h.store.close();
  assert.equal(query.presentCall({ collection: 'contacts', offset: 0, limit: 1 }).card, 'generic');
  assert.equal(query.presentCall({ collection: 'invalid' }), undefined);
  assert.deepEqual(change.presentResult({}, result).content, result.content);
  assert.equal(change.presentResult({}, { ...result, isError: true }).title, 'Enterprise change failed');
});

for (const outcome of ['rejected', 'cancelled']) {
  test(`CRM edits and order draft edits preserve stored records after ${outcome} approval`, async t => {
    const h = await setup(t);
    seed(h.store);
    const before = h.store.snapshot();
    h.ctx.on('approval/request', async () => outcome);
    for (const command of [
      { type: 'contact.upsert', contact: { ...contact, stage: 'lost' } },
      { type: 'order.save', order: { ...order, note: 'unapproved draft edit' } },
    ]) {
      const result = await h.command(command);
      assert.equal(result.isError, true);
      assert.match(resultText(result), new RegExp(`approval_${outcome}`));
      assert.deepEqual(h.store.snapshot(), before);
    }
  });
}

test('a read-only delegated Session with never approval cannot change CRM or order drafts', async t => {
  const h = await setup(t);
  seed(h.store);
  const before = h.store.snapshot();
  const id = SessionId(randomUUID());
  const session = Session.create(id, undefined, { ...h.session.header, id, origin: 'subagent', parentSession: h.session.id });
  session.append('turn/start', { turn: 1 });
  setSandboxMode(session, 'read-only');
  setApprovalPolicy(session, 'never');
  let asked = 0;
  h.ctx.on('approval/request', async () => { asked++; return 'allowed-once'; });
  for (const command of [
    { type: 'contact.upsert', contact: { ...contact, stage: 'lost' } },
    { type: 'order.save', order: { ...order, note: 'delegated draft edit' } },
  ]) {
    const result = await h.ctx.tools.execute({
      callId: randomUUID(), name: 'enterprise_command', arguments: { request: request(h.store, command) },
      agent: { id, session }, signal: new AbortController().signal,
    });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /approval_rejected/);
    assert.deepEqual(h.store.snapshot(), before);
  }
  assert.equal(asked, 0);
});

test('approved CRM replay returns the committed receipt without asking or applying twice', async t => {
  const h = await setup(t);
  let asked = 0;
  h.ctx.on('approval/request', async () => { asked++; return 'allowed-once'; });
  const envelope = { request: request(h.store, { type: 'contact.upsert', contact }) };
  const first = await h.execute('enterprise_command', envelope);
  assert.equal(first.isError, false, resultText(first));
  const replay = await h.execute('enterprise_command', envelope);
  assert.deepEqual(replay.value, first.value);
  assert.equal(h.store.snapshot().revision, 1);
  assert.equal(asked, 1);
});

test('collection pages search Unicode text fields and retain both versions across pagination', async t => {
  const h = await setup(t, { maxQueryRows: 2 });
  seed(h.store);
  h.store.execute(request(h.store, { type: 'contact.upsert', contact: { ...contact, id: 'unicode-a', name: 'ÉCOLE', company: 'Åsa % _', nextAction: 'quoted "owner"\\path' } }));
  h.store.execute(request(h.store, { type: 'contact.upsert', contact: { ...contact, id: 'unicode-b', name: 'école', company: 'Different', nextAction: 'literal search' } }));
  h.store.execute(request(h.store, { type: 'contact.upsert', contact: { ...contact, id: 'unicode-c', name: 'İstanbul', company: 'Different', nextAction: 'literal search' } }));
  const baseline = h.store.snapshot();
  for (const collection of ['contacts', 'inventory', 'orders', 'audit']) {
    for (const search of ['', 'ÉCOLE', 'ÅSA', 'i\u0307st', 'owner', '%', '_', '"name":', "' OR 1=1 --"]) {
      const expected = baseline[collection].filter(row => {
        const fields = Object.entries(row).filter(([key, value]) => typeof value === 'string' && key !== 'commandId').map(([, value]) => value);
        if (collection === 'audit') fields.push(row.commandId, JSON.stringify(row.before), JSON.stringify(row.after));
        if (collection === 'orders') fields.push(...row.lines.map(line => line.itemId));
        return fields.some(value => value.toLowerCase().includes(search.toLowerCase()));
      });
      const received = [];
      let offset = 0;
      do {
        const result = await h.execute('enterprise_query', { collection, search, offset, limit: 2, revision: baseline.revision, generation: baseline.generation });
        assert.equal(result.isError, false, resultText(result));
        assert.equal(result.value.total, expected.length);
        received.push(...result.value.records);
        offset = result.value.nextOffset;
      } while (offset !== null);
      assert.deepEqual(received, expected, `${collection}: ${search}`);
    }
  }
  for (const id of [contact.id, baseline.audit[0].commandId]) {
    const expected = baseline.audit.filter(row => row.entityId === id || row.commandId === id);
    const result = await h.execute('enterprise_query', { collection: 'audit', id, offset: 0, limit: 2 });
    assert.deepEqual(result.value.records, expected.slice(0, 2));
    assert.equal(result.value.total, expected.length);
  }
  const beyond = await h.execute('enterprise_query', { collection: 'contacts', offset: 100, limit: 1, revision: baseline.revision, generation: baseline.generation });
  assert.deepEqual(beyond.value.records, []);
  assert.equal(beyond.value.total, baseline.contacts.length);
  assert.equal(beyond.value.nextOffset, null);
  h.store.executeReceipt({ revision: baseline.revision, commandId: randomUUID(), command: { type: 'contact.upsert', contact } });
  const stale = await h.execute('enterprise_query', { collection: 'contacts', offset: 2, limit: 1, revision: baseline.revision, generation: baseline.generation });
  assert.equal(stale.isError, true);
  assert.match(resultText(stale), /revision_conflict/);
});

test('a one-record query, approval, commit and replay never scan unrelated audit history', async t => {
  const h = await setup(t, { maxQueryRows: 1, maxQueryBytes: 4096 });
  seed(h.store);
  for (let revision = 3; revision < 2000; revision++) {
    h.store.executeReceipt({ revision, commandId: `history-${revision}`, command: {
      type: 'contact.upsert', contact: { ...contact, nextAction: 'x'.repeat(2000) },
    } });
  }
  const db = h.store.db;
  const original = db.prepare.bind(db);
  const statements = [];
  t.mock.method(db, 'prepare', sql => { statements.push(sql); return original(sql); });
  const query = await h.execute('enterprise_query', { collection: 'contacts', id: contact.id, offset: 0, limit: 1 });
  assert.equal(query.isError, false, resultText(query));
  assert.equal(query.value.records.length, 1);
  assert.ok(Buffer.byteLength(resultText(query)) <= 4096);
  assert.ok(statements.every(sql => !/\b(enterprise_audit|inventory|orders|order_lines)\b/i.test(sql)), statements.join('\n'));
  const queries = statements.filter(sql => /FROM contacts/i.test(sql));
  assert.equal(queries.length, 2);
  assert.match(queries[1], /LIMIT \? OFFSET \?/);
  let asked = 0;
  h.ctx.on('approval/request', async event => {
    asked++;
    assert.match(event.reason, /x{2000}/);
    return 'allowed-once';
  });
  const envelope = { request: { revision: query.value.revision, commandId: 'bounded-write', command: {
    type: 'contact.upsert', contact: { ...contact, nextAction: 'approved replacement' },
  } } };
  statements.length = 0;
  const committed = await h.execute('enterprise_command', envelope);
  assert.equal(committed.isError, false, resultText(committed));
  assert.equal(committed.value.commandRevision, 2001);
  const replay = await h.execute('enterprise_command', envelope);
  assert.deepEqual(replay.value, committed.value);
  assert.equal(asked, 1);
  const auditReads = statements.filter(sql => /SELECT.+FROM enterprise_audit/i.test(sql));
  assert.equal(auditReads.length, 3, 'prepare, commit and exact replay each look up one receipt');
  assert.ok(auditReads.every(sql => /WHERE commandId = \?/.test(sql)), auditReads.join('\n'));
  assert.ok(statements.every(sql => !/FROM (inventory|orders|order_lines)/i.test(sql)), statements.join('\n'));
});
