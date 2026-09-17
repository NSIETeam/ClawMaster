/** Plain Node worker exercising the production enterprise store with synthetic records. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openEnterpriseStore, mountEnterpriseRoutes } from '../src/enterprise-host.ts';

const [mode, databasePath, countText] = process.argv.slice(2);
const count = Number(countText);
assert.ok(databasePath && Number.isSafeInteger(count) && count > 0);
const contact = index => ({
  id: `contact-${index}`, name: `Contact ${String(index).padStart(6, '0')}`, company: `Company ${index % 20}`,
  stage: 'proposal', nextAction: 'Review the synthetic proposal', nextActionDate: '2026-09-20',
});
let store;
let removeRoutes;
let revision = 0;
try {
  if (mode === 'seed') {
    store = await openEnterpriseStore(databasePath);
    store.close();
    const db = new DatabaseSync(databasePath);
    const insertContact = db.prepare('INSERT INTO contacts (id,name,company,stage,nextAction,nextActionDate,updatedAt) VALUES (?,?,?,?,?,?,?)');
    const insertItem = db.prepare('INSERT INTO inventory (id,sku,name,stock,reorderAt,supplier,updatedAt) VALUES (?,?,?,?,?,?,?)');
    const insertOrder = db.prepare('INSERT INTO orders (id,kind,counterparty,orderDate,currency,status,totalMinorUnits,note,updatedAt,submittedAt) VALUES (?,?,?,?,?,?,?,?,?,NULL)');
    const insertLine = db.prepare('INSERT INTO order_lines (orderId,position,itemId,quantity,unitPriceMinorUnits) VALUES (?,0,?,2,12345)');
    const insertAudit = db.prepare('INSERT INTO enterprise_audit (revision,commandId,type,entityId,at,commandJson,beforeJson,afterJson) VALUES (?,?,?,?,?,?,?,?)');
    const timestamp = '2026-09-16T00:00:00.000Z';
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < count; index++) {
        const contactRecord = { ...contact(index), updatedAt: timestamp };
        const itemRecord = { id: `item-${index}`, sku: `SKU-${index}`, name: `Item ${index}`, stock: 1000, reorderAt: 10,
          supplier: `Supplier ${index % 10}`, updatedAt: timestamp };
        const orderRecord = { id: `order-${index}`, kind: 'sale', counterparty: `Company ${index % 20}`, orderDate: '2026-09-16',
          currency: 'CNY', lines: [{ itemId: `item-${index}`, quantity: 2, unitPriceMinorUnits: 12345 }], note: 'Synthetic draft',
          status: 'draft', totalMinorUnits: 24690, updatedAt: timestamp, submittedAt: null };
        const commands = [
          { type: 'contact.upsert', entity: contactRecord, before: null },
          { type: 'item.upsert', entity: itemRecord, before: null },
          { type: 'order.save', entity: orderRecord, before: null },
          { type: 'contact.upsert', entity: { ...contactRecord, nextAction: 'Review 0' }, before: contactRecord },
          { type: 'contact.upsert', entity: { ...contactRecord, nextAction: 'Review 1' }, before: { ...contactRecord, nextAction: 'Review 0' } },
        ];
        insertContact.run(contactRecord.id, contactRecord.name, contactRecord.company, contactRecord.stage, 'Review 1',
          contactRecord.nextActionDate, timestamp);
        insertItem.run(itemRecord.id, itemRecord.sku, itemRecord.name, itemRecord.stock, itemRecord.reorderAt, itemRecord.supplier, timestamp);
        insertOrder.run(orderRecord.id, orderRecord.kind, orderRecord.counterparty, orderRecord.orderDate, orderRecord.currency,
          orderRecord.status, orderRecord.totalMinorUnits, orderRecord.note, timestamp);
        insertLine.run(orderRecord.id, `item-${index}`);
        for (const [offset, { type, entity, before }] of commands.entries()) {
          const revision = index * 5 + offset + 1;
          const command = type === 'contact.upsert' ? { type, contact: { id: entity.id, name: entity.name, company: entity.company,
            stage: entity.stage, nextAction: entity.nextAction, nextActionDate: entity.nextActionDate } }
            : type === 'item.upsert' ? { type, item: { id: entity.id, sku: entity.sku, name: entity.name, stock: entity.stock,
              reorderAt: entity.reorderAt, supplier: entity.supplier } } : { type, order: { id: entity.id, kind: entity.kind,
              counterparty: entity.counterparty, orderDate: entity.orderDate, currency: entity.currency, lines: entity.lines, note: entity.note } };
          insertAudit.run(revision, `command-${revision}`, type, entity.id, timestamp, JSON.stringify(command), JSON.stringify(before), JSON.stringify(entity));
        }
      }
      db.prepare('UPDATE enterprise_meta SET revision=? WHERE singleton=1').run(count * 5);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
    db.close();
    store = await openEnterpriseStore(databasePath);
    const overview = store.overview();
    assert.equal(overview.revision, count * 5);
    assert.equal(overview.counts.contacts, count);
    assert.equal(overview.counts.inventory, count);
    assert.equal(overview.counts.orders, count);
    store.close();
    revision = count * 5;
    process.stdout.write(JSON.stringify({ revision, recordsPerCollection: count }));
  } else {
    assert.equal(mode, 'sample');
    const samples = {};
    const measure = async (name, operation, serialize = true) => {
      process.stderr.write(`measuring ${name}\n`);
      globalThis.gc?.();
      const before = process.memoryUsage();
      const started = performance.now();
      let finished = false;
      const eventLoop = (async () => {
        let previous = started;
        let maximum = 0;
        while (!finished) {
          await setImmediate();
          const current = performance.now();
          maximum = Math.max(maximum, current - previous);
          previous = current;
        }
        return maximum;
      })();
      try {
        const result = await operation();
        const encoded = serialize && !(result instanceof Blob) ? JSON.stringify(result) : undefined;
        const elapsedMs = performance.now() - started;
        const retained = process.memoryUsage();
        finished = true;
        samples[name] = {
          elapsedMs, eventLoopRoundtripMs: await eventLoop,
          responseBytes: result instanceof Blob ? result.size : encoded === undefined ? null : Buffer.byteLength(encoded),
          rssBeforeBytes: before.rss, rssAfterBytes: retained.rss, heapAfterBytes: retained.heapUsed,
          processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
          childPeakRssBytes: store?.backupResourceUsage()[name === 'backup' ? 'export' : name === 'prepareBackup' ? 'prepare' : name] ?? 0,
        };
        return result;
      } finally {
        finished = true;
        await eventLoop;
      }
    };
    store = await measure('open', () => openEnterpriseStore(databasePath), false);
    const routes = new Map();
    removeRoutes = await mountEnterpriseRoutes({ connection: { fetch: { register(route) {
      routes.set(route.path, route.fetch); return async () => { routes.delete(route.path); };
    } } } }, store);
    const fetch = async (suffix = '', init) => {
      const request = new Request(`http://fixture/api/clawmaster/enterprise${suffix}`, init);
      const response = await routes.get(new URL(request.url).pathname)(request);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return suffix === '/backup' ? response.blob() : response.json();
    };
    const overview = await measure('overview', () => fetch());
    const query = value => fetch(`/query?${new URLSearchParams({ collection: 'contacts', offset: '0', limit: '50',
      generation: String(overview.generation), revision: String(overview.revision), ...value })}`);
    const page = await measure('list', () => query({}));
    assert.equal(page.total, count);
    assert.equal(page.records.length, Math.min(50, count));
    revision = page.revision;
    assert.equal(revision, count * 5);
    await measure('search', () => query({ search: 'Company 7' }));
    const audit = await measure('auditTail', () => query({ collection: 'audit', offset: String(Math.max(0, revision - 50)) }));
    assert.equal(audit.total, revision);
    const saved = await measure('saveReceipt', () => fetch('/command', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 0, revision, commandId: 'measured-save', command: { type: 'contact.upsert', contact: { ...contact(0), nextAction: 'Measured update' } } }) }));
    assert.equal(saved.commandRevision, count * 5 + 1);
    assert.equal(saved.entityId, 'contact-0');
    revision = saved.revision;
    const backup = await measure('backup', () => fetch('/backup'));
    const prepared = await measure('prepareBackup', () => fetch('/backup/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: backup }));
    const restored = await measure('restore', () => fetch('/restore', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: prepared.token, backupSha256: prepared.backupSha256, commandId: 'capacity-restore', expectedRevision: revision, expectedGeneration: 0, confirm: true }) }));
    assert.equal(store.overview().counts.contacts, count);
    assert.equal(restored.generation, 1);
    process.stdout.write(JSON.stringify({ samples, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
  }
} finally {
  await removeRoutes?.();
  store?.close();
}
