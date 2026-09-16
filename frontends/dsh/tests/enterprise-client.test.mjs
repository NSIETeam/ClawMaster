import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_HTTP_IDENTITY } from '../src/governance-audit.ts';
import { EnterpriseClient, moneyInputToMinorUnits, minorUnitsToMoneyInput, quantityInputToInteger } from '../src/enterprise-client.ts';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { enterpriseTransport, overviewOf } from './enterprise-transport.fixture.mjs';

const contact = { id: 'contact-1', name: 'Contact', company: '', stage: 'lead', nextAction: '', nextActionDate: null };
const command = { type: 'contact.upsert', contact };
const baseline = { generation: 0, revision: 0, contacts: [], inventory: [], orders: [], audit: [] };
const prepared = { token: 'prepared-token', backupSha256: 'a'.repeat(64), exportedAt: '2026-09-14T00:00:00.000Z', generation: 0, revision: 0, counts: { contacts: 0, inventory: 0, orders: 0, audit: 0 } };
const restoreReceipt = (request, result = { generation: 1, revision: 0 }) => ({ commandId: request.commandId, backupSha256: request.backupSha256, generation: result.generation, revision: result.revision });

function receipt(store, request) {
  const result = store.executeReceipt(request, LOCAL_HTTP_IDENTITY);
  const { commandId, revision: commandRevision, entityId, type, at } = result.receipt;
  return { generation: result.generation, revision: result.revision, commandId, commandRevision, entityId, type, at };
}

test('retained edits and confirmations cannot acquire a restored generation by refreshing', async () => {
  let current = baseline;
  const sent = [];
  const client = new EnterpriseClient(async (path, init) => {
    if (init.method === 'GET') return Response.json(overviewOf(current));
    sent.push(path);
    current = { ...baseline, generation: 1 };
    return Response.json(restoreReceipt(JSON.parse(init.body), current));
  });
  await client.refresh();
  const reviewedGeneration = client.getSnapshot().overview.generation;
  await client.restore(prepared, 0, 0);
  await client.refresh();
  for (const operation of [command, ...['contact.remove', 'item.remove', 'order.remove', 'order.submit'].map(type => ({ type, id: 'record-1' }))]) {
    assert.equal(await client.execute(operation, 0, reviewedGeneration), false);
    assert.equal(client.getSnapshot().error, 'stale_form');
  }
  assert.deepEqual(sent, ['/api/clawmaster/enterprise/restore']);
});

test('decimal amounts and quantities reject rounding, exponent notation, and unsafe integers', () => {
  assert.equal(moneyInputToMinorUnits('12.34'), 1234);
  assert.equal(moneyInputToMinorUnits('0.1'), 10);
  assert.equal(moneyInputToMinorUnits('0002.05'), 205);
  assert.equal(moneyInputToMinorUnits('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(minorUnitsToMoneyInput(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  for (const input of ['', '1.001', '1e2', '-1', '.2', '1.', ' 1.00 ']) assert.throws(() => moneyInputToMinorUnits(input), { code: 'invalid_request' });
  assert.throws(() => moneyInputToMinorUnits('90071992547409.92'), { code: 'numeric_overflow' });
  assert.equal(quantityInputToInteger('0', 0), 0);
  assert.equal(quantityInputToInteger('12', 1), 12);
  for (const input of ['0', '1.2', '-1', '1e2', '']) assert.throws(() => quantityInputToInteger(input, 1), { code: 'invalid_request' });
});

test('loading validates version counters and leaves the last known overview visible on invalid response', async () => {
  let response = overviewOf(baseline);
  const client = new EnterpriseClient(async (path, init) => {
    assert.equal(path, '/api/clawmaster/enterprise');
    assert.equal(init.credentials, 'same-origin');
    return Response.json(response);
  });
  await client.refresh();
  assert.deepEqual(client.getSnapshot().overview, overviewOf(baseline));
  response = { ...overviewOf(baseline), revision: 4 };
  await client.refresh();
  assert.equal(client.getSnapshot().error, 'invalidResponse');
  assert.deepEqual(client.getSnapshot().overview, overviewOf(baseline));
  assert.equal(client.getSnapshot().loading, false);
});

test('an uncertain committed write retries the exact request and commits only once', async context => {
  const store = await openEnterpriseStore(':memory:');
  context.after(() => store.close());
  const requests = [];
  let loseResponse = true;
  const client = new EnterpriseClient(async (_path, init) => {
    if (init.method === 'GET') return Response.json(store.overview());
    const request = JSON.parse(init.body);
    requests.push(request);
    const snapshot = receipt(store, request);
    if (loseResponse) { loseResponse = false; throw new TypeError('connection lost after commit'); }
    return Response.json(snapshot);
  }, () => 'command-1');
  await client.refresh();
  assert.equal(await client.execute(command, 0), false);
  assert.equal(client.getSnapshot().pending, true);
  assert.equal(client.getSnapshot().error, 'networkError');
  assert.equal(await client.execute({ ...command, contact: { ...contact, name: 'Changed input' } }, 0), false);
  assert.equal(client.getSnapshot().error, 'pending_command');
  assert.deepEqual(await client.retryPending(), command);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(store.snapshot().revision, 1);
  assert.equal(store.snapshot().contacts[0].name, 'Contact');
  assert.equal(client.getSnapshot().pending, false);
});

test('a stale revision never updates the local snapshot until an explicit refresh', async context => {
  const store = await openEnterpriseStore(':memory:');
  context.after(() => store.close());
  const client = new EnterpriseClient(async (_path, init) => {
    if (init.method === 'GET') return Response.json(store.overview());
    try { return Response.json(receipt(store, JSON.parse(init.body))); }
    catch (error) { return Response.json({ error: { code: error.code, message: error.message, currentRevision: error.currentRevision } }, { status: 409 }); }
  }, () => 'client-command');
  await client.refresh();
  store.execute({ revision: 0, commandId: 'other-page-command', command });
  assert.equal(await client.execute({ ...command, contact: { ...contact, name: 'Retained input' } }, 0), false);
  assert.equal(client.getSnapshot().error, 'revision_conflict');
  assert.equal(client.getSnapshot().pending, false);
  assert.equal(client.getSnapshot().overview.revision, 0);
  await client.refresh();
  assert.equal(client.getSnapshot().overview.revision, 1);
  assert.equal(await client.execute({ ...command, contact: { ...contact, name: 'Retained input' } }, 1), true);
  assert.equal(store.snapshot().contacts[0].name, 'Retained input');
});

test('a delayed read cannot overwrite a newly committed snapshot', async context => {
  const store = await openEnterpriseStore(':memory:');
  context.after(() => store.close());
  let release;
  let delayRead = false;
  const client = new EnterpriseClient(async (_path, init) => {
    if (init.method === 'POST') return Response.json(receipt(store, JSON.parse(init.body)));
    if (delayRead) { delayRead = false; return new Promise(resolve => { release = () => resolve(Response.json(overviewOf(baseline))); }); }
    return Response.json(store.overview());
  }, () => 'command-1');
  await client.refresh();
  delayRead = true;
  const staleRead = client.refresh();
  assert.equal(await client.execute(command, 0), true);
  release();
  await staleRead;
  assert.equal(client.getSnapshot().overview.revision, 1);
  assert.equal(client.getSnapshot().overview.counts.contacts, 1);
});

test('a valid but uncommitted success response remains unresolved', async () => {
  const client = new EnterpriseClient(async () => Response.json(overviewOf(baseline)), () => 'command-1');
  await client.refresh();
  assert.equal(await client.execute(command, 0), false);
  assert.equal(client.getSnapshot().error, 'invalidResponse');
  assert.equal(client.getSnapshot().pending, true);
});

for (const type of ['contact.upsert', 'item.upsert', 'order.save', 'contact.remove', 'item.remove', 'order.remove', 'order.submit']) {
  test(`${type} keeps the reviewed revision after another component refreshes the shared client`, async context => {
    const store = await openEnterpriseStore(':memory:');
    context.after(() => store.close());
    const item = { id: 'sku-1', sku: 'SKU', name: 'Synthetic item', stock: 8, reorderAt: 1, supplier: '' };
    const order = { id: 'order-1', kind: 'sale', counterparty: 'Synthetic customer', orderDate: '2026-09-14', currency: 'CNY', lines: [{ itemId: item.id, quantity: 2, unitPriceMinorUnits: 1200 }], note: '' };
    const write = value => store.execute({ revision: store.snapshot().revision, commandId: crypto.randomUUID(), command: value });
    write(command); write({ type: 'item.upsert', item }); write({ type: 'order.save', order });
    const client = new EnterpriseClient(async (_path, init) => {
      if (init.method === 'GET') return Response.json(store.overview());
      try { return Response.json(receipt(store, JSON.parse(init.body))); }
      catch (error) { return Response.json({ error: { code: error.code, message: error.message, currentRevision: error.currentRevision } }, { status: 409 }); }
    });
    await client.refresh();
    const reviewedRevision = client.getSnapshot().overview.revision;
    const input = type === 'contact.upsert' ? { type, contact: { ...contact, nextAction: 'Retained draft' } }
      : type === 'item.upsert' ? { type, item: { ...item, supplier: 'Retained draft' } }
      : type === 'order.save' ? { type, order: { ...order, note: 'Retained draft' } }
      : { type, id: type.startsWith('contact') ? contact.id : type.startsWith('item') ? item.id : order.id };
    write({ type: 'contact.upsert', contact: { ...contact, company: 'Newer company' } });
    const newer = store.snapshot();
    await client.refresh();
    assert.equal(await client.execute(input, reviewedRevision), false);
    assert.equal(client.getSnapshot().error, 'revision_conflict');
    assert.deepEqual(store.snapshot(), newer, 'stale saves, deletion and submission leave every record and stock value unchanged');
    assert.equal(client.getSnapshot().pending, false);
    if (type === 'contact.upsert') {
      assert.equal(await client.execute(input, newer.revision), true, 'only an explicitly reviewed current revision may save the retained draft');
    }
  });
}
test('restore fences delayed reads and blocks concurrent mutations until its response settles', async context => {
  const store = await openEnterpriseStore(':memory:');
  context.after(() => store.close());
  const backup = store.backup();
  store.execute({ revision: 0, commandId: 'first', command });
  let delayedRead;
  let delayedRestore;
  let deferRead = false;
  const client = new EnterpriseClient(async (path, init) => {
    if (path.endsWith('/restore')) {
      const request = JSON.parse(init.body);
      const result = store.restore(backup, request.expectedRevision, request.expectedGeneration);
      return new Promise(resolve => { delayedRestore = () => resolve(Response.json(restoreReceipt(request, result))); });
    }
    if (init.method === 'POST') return Response.json(receipt(store, JSON.parse(init.body)));
    const snapshot = store.overview();
    if (deferRead) { deferRead = false; return new Promise(resolve => { delayedRead = () => resolve(Response.json(snapshot)); }); }
    return Response.json(snapshot);
  }, () => 'client-write');
  await client.refresh();
  deferRead = true;
  const read = client.refresh();
  const restoring = client.restore(prepared, 1, 0);
  assert.equal(client.getSnapshot().saving, true);
  assert.equal(await client.execute(command, client.getSnapshot().overview.revision, client.getSnapshot().overview.generation), false);
  await assert.rejects(client.restore(prepared, 1, 0), { code: 'invalid_request' });
  delayedRestore();
  await restoring;
  delayedRead();
  await read;
  assert.deepEqual(client.getSnapshot().overview, { ...overviewOf(baseline), generation: 1 });
  assert.equal(client.getSnapshot().saving, false);
  assert.equal(await client.execute(command, client.getSnapshot().overview.revision, client.getSnapshot().overview.generation), true);
});

test('an uncertain restore retains its exact receipt query across refresh and only then unlocks mutations', async context => {
  const store = await openEnterpriseStore(':memory:');
  context.after(() => store.close());
  const backup = store.backup();
  const requests = [];
  let committed;
  const client = new EnterpriseClient(async (path, init) => {
    if (path.endsWith('/restore')) {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (committed) return Response.json(committed);
      committed = restoreReceipt(request, store.restore(backup, request.expectedRevision, request.expectedGeneration));
      throw new TypeError('response lost after restore');
    }
    if (init.method === 'POST') return Response.json(receipt(store, JSON.parse(init.body)));
    return Response.json(store.overview());
  }, () => 'client-write');
  await client.refresh();
  await assert.rejects(client.restore(prepared, 0, 0), /response lost/);
  assert.equal(client.getSnapshot().pending, true);
  assert.equal(await client.execute(command, 0, 0), false);
  await assert.rejects(client.restore(prepared, 0, 0));
  await client.refresh();
  assert.equal(client.getSnapshot().pending, true, 'reading counters cannot prove which restore committed');
  assert.equal(client.getSnapshot().overview.generation, 1);
  assert.deepEqual(await client.retryRestore(), committed);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(client.getSnapshot().pending, false);
  assert.equal(store.overview().generation, 1);
  assert.equal(await client.execute(command, client.getSnapshot().overview.revision, client.getSnapshot().overview.generation), true);
});

test('restore preserves a server revision conflict and does not replace the displayed snapshot', async () => {
  const client = new EnterpriseClient(async (_path, init) => init.method === 'GET' ? Response.json(overviewOf(baseline))
    : Response.json({ error: { code: 'revision_conflict', message: 'Refresh before restoring.' } }, { status: 409 }));
  await client.refresh();
  await assert.rejects(client.restore(prepared, 0, 0), { code: 'revision_conflict' });
  assert.equal(client.getSnapshot().error, 'revision_conflict');
  assert.equal(client.getSnapshot().pending, false);
  assert.deepEqual(client.getSnapshot().overview, overviewOf(baseline));
});

test('the client reads bounded production HTTP pages, rejects stale continuation and saves using only a receipt', async context => {
  const store = await openEnterpriseStore(':memory:');
  const transport = await enterpriseTransport(store);
  context.after(async () => { await transport.dispose(); store.close(); });
  for (let index = 0; index < 7; index++) receipt(store, { generation: 0, revision: index, commandId: `seed-${index}`,
    command: { type: 'contact.upsert', contact: { ...contact, id: `contact-${index}`, name: `Contact ${index}`, company: index % 2 ? 'Match' : 'Other' } } });
  const responses = [];
  const client = new EnterpriseClient(async (path, init) => {
    const response = await transport.fetch(path, init);
    if (init.method === 'POST') responses.push(await response.clone().json());
    return response;
  }, () => 'bounded-save');
  await client.refresh();
  assert.equal(client.getSnapshot().overview.counts.contacts, 7);
  assert.equal('snapshot' in client.getSnapshot(), false);
  const version = { generation: 0, revision: 7 };
  const first = await client.query({ collection: 'contacts', offset: 0, limit: 2, ...version });
  const second = await client.query({ collection: 'contacts', offset: first.nextOffset, limit: 2, ...version });
  assert.equal(new Set([...first.records, ...second.records].map(record => record.id)).size, 4);
  const filtered = await client.query({ collection: 'contacts', search: 'Match', offset: 0, limit: 2, ...version });
  assert.equal(filtered.total, 3);
  assert.equal(await client.execute({ type: 'contact.upsert', contact: { ...contact, name: 'Saved through HTTP' } }, 7, 0), true);
  assert.deepEqual(Object.keys(responses[0]).sort(), ['at', 'commandId', 'commandRevision', 'entityId', 'generation', 'revision', 'type']);
  assert.equal(client.getSnapshot().overview.revision, 8);
  await assert.rejects(client.query({ collection: 'contacts', offset: second.nextOffset, limit: 2, ...version }), { code: 'revision_conflict' });
  assert.equal(client.getSnapshot().pending, false);
});

test('confirmed writes remain saved when the following overview refresh fails', async context => {
  const store = await openEnterpriseStore(':memory:');
  context.after(() => store.close());
  let saved = false;
  const client = new EnterpriseClient(async (_path, init) => {
    if (init.method === 'POST') { saved = true; return Response.json(receipt(store, JSON.parse(init.body))); }
    if (saved) throw new TypeError('read connection lost');
    return Response.json(store.overview());
  }, () => 'confirmed');
  await client.refresh();
  assert.equal(await client.execute(command, 0, 0), true);
  assert.equal(client.getSnapshot().pending, false);
  assert.equal(client.getSnapshot().error, 'networkError');
  assert.equal(await client.retryPending(), null);
  assert.equal(store.overview().revision, 1);
});

for (const changed of [{ commandId: 'other-command' }, { entityId: 'other-contact' }, { type: 'item.upsert' }, { generation: 1 }, { commandRevision: 2, revision: 2 }]) {
  test(`unrelated receipt leaves the exact write unresolved: ${JSON.stringify(changed)}`, async () => {
    const client = new EnterpriseClient(async (_path, init) => Response.json(init.method === 'GET' ? overviewOf(baseline)
      : { generation: 0, revision: 1, commandId: 'expected', commandRevision: 1, entityId: contact.id,
        type: command.type, at: '2026-09-16T00:00:00.000Z', ...changed }), () => 'expected');
    await client.refresh();
    assert.equal(await client.execute(command, 0, 0), false);
    assert.equal(client.getSnapshot().pending, true);
    assert.equal(client.getSnapshot().error, 'invalidResponse');
  });
}

test('a denied write has a known outcome and does not offer idempotent replay', async () => {
  const client = new EnterpriseClient(async (_path, init) => init.method === 'GET' ? Response.json(overviewOf(baseline))
    : Response.json({ error: { code: 'permission_denied', message: 'Approval required.' } }, { status: 403 }));
  await client.refresh();
  assert.equal(await client.execute(command, 0, 0), false);
  assert.equal(client.getSnapshot().pending, false);
  assert.equal(client.getSnapshot().error, 'permission_denied');
  assert.equal(await client.retryPending(), null);
});

test('an abandoned page cannot overwrite a newer successful read with its late failure', async () => {
  const response = Promise.withResolvers();
  const client = new EnterpriseClient(async path => path.includes('/query?') ? response.promise : Response.json(overviewOf(baseline)));
  await client.refresh();
  const controller = new AbortController();
  const page = client.query({ collection: 'contacts', offset: 0, limit: 2, generation: 0, revision: 0 }, controller.signal);
  controller.abort();
  response.resolve(Response.json({ error: { code: 'revision_conflict', message: 'Stale.' } }, { status: 409 }));
  await assert.rejects(page, { code: 'revision_conflict' });
  assert.equal(client.getSnapshot().error, null);
  assert.equal(client.getSnapshot().readUnavailable, false);
});

for (const status of [408, 503]) test(`command ${status} keeps an exact retry instead of permitting a replacement write`, async () => {
  const store = await openEnterpriseStore(':memory:'); const sent = []; let attempt = 0;
  const client = new EnterpriseClient(async (path, init) => {
    if (init.method === 'GET') return Response.json(store.overview());
    sent.push(JSON.parse(init.body)); attempt++;
    if (attempt === 1) return Response.json({ error: { code: 'storage_unavailable', message: 'Command admission unavailable' } }, { status });
    return Response.json(receipt(store, sent.at(-1)));
  }, () => 'same-command');
  try {
    await client.refresh(); assert.equal(await client.execute(command, 0), false);
    assert.equal(client.getSnapshot().pending, true);
    assert.equal(await client.execute(command, 0), false); assert.equal(sent.length, 1);
    assert.deepEqual(await client.retryPending(), command); assert.deepEqual(sent[0], sent[1]);
    assert.equal(store.overview().revision, 1); assert.equal(client.getSnapshot().pending, false);
  } finally { store.close(); }
});
