import assert from 'node:assert/strict';
import test from 'node:test';
import { EnterpriseClient, moneyInputToMinorUnits, minorUnitsToMoneyInput, quantityInputToInteger } from '../src/enterprise-client.ts';
import { openEnterpriseStore } from '../src/enterprise-host.ts';

const contact = { id: 'contact-1', name: 'Contact', company: '', stage: 'lead', nextAction: '', nextActionDate: null };
const command = { type: 'contact.upsert', contact };
const baseline = { revision: 0, contacts: [], inventory: [], orders: [], audit: [] };

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

test('loading validates the full snapshot and leaves the last known records visible on invalid response', async () => {
  let response = baseline;
  const client = new EnterpriseClient(async (path, init) => {
    assert.equal(path, '/api/clawmaster/enterprise');
    assert.equal(init.credentials, 'same-origin');
    return Response.json(response);
  });
  await client.refresh();
  assert.deepEqual(client.getSnapshot().snapshot, baseline);
  response = { ...baseline, revision: 4 };
  await client.refresh();
  assert.equal(client.getSnapshot().error, 'invalidResponse');
  assert.deepEqual(client.getSnapshot().snapshot, baseline);
  assert.equal(client.getSnapshot().loading, false);
});

test('an uncertain committed write retries the exact request and commits only once', async context => {
  const store = await openEnterpriseStore(':memory:');
  context.after(() => store.close());
  const requests = [];
  let loseResponse = true;
  const client = new EnterpriseClient(async (_path, init) => {
    if (init.method === 'GET') return Response.json(store.snapshot());
    const request = JSON.parse(init.body);
    requests.push(request);
    const snapshot = store.execute(request);
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
    if (init.method === 'GET') return Response.json(store.snapshot());
    try { return Response.json(store.execute(JSON.parse(init.body))); }
    catch (error) { return Response.json({ error: { code: error.code, message: error.message, currentRevision: error.currentRevision } }, { status: 409 }); }
  }, () => 'client-command');
  await client.refresh();
  store.execute({ revision: 0, commandId: 'other-page-command', command });
  assert.equal(await client.execute({ ...command, contact: { ...contact, name: 'Retained input' } }, 0), false);
  assert.equal(client.getSnapshot().error, 'revision_conflict');
  assert.equal(client.getSnapshot().pending, false);
  assert.equal(client.getSnapshot().snapshot.revision, 0);
  await client.refresh();
  assert.equal(client.getSnapshot().snapshot.revision, 1);
  assert.equal(await client.execute({ ...command, contact: { ...contact, name: 'Retained input' } }, 1), true);
  assert.equal(store.snapshot().contacts[0].name, 'Retained input');
});

test('a delayed read cannot overwrite a newly committed snapshot', async context => {
  const store = await openEnterpriseStore(':memory:');
  context.after(() => store.close());
  let release;
  let delayRead = false;
  const client = new EnterpriseClient(async (_path, init) => {
    if (init.method === 'POST') return Response.json(store.execute(JSON.parse(init.body)));
    if (delayRead) return new Promise(resolve => { release = () => resolve(Response.json(baseline)); });
    return Response.json(store.snapshot());
  }, () => 'command-1');
  await client.refresh();
  delayRead = true;
  const staleRead = client.refresh();
  assert.equal(await client.execute(command, 0), true);
  release();
  await staleRead;
  assert.equal(client.getSnapshot().snapshot.revision, 1);
  assert.equal(client.getSnapshot().snapshot.contacts.length, 1);
});

test('a valid but uncommitted success response remains unresolved', async () => {
  const client = new EnterpriseClient(async () => Response.json(baseline), () => 'command-1');
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
      if (init.method === 'GET') return Response.json(store.snapshot());
      try { return Response.json(store.execute(JSON.parse(init.body))); }
      catch (error) { return Response.json({ error: { code: error.code, message: error.message, currentRevision: error.currentRevision } }, { status: 409 }); }
    });
    await client.refresh();
    const reviewedRevision = client.getSnapshot().snapshot.revision;
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
