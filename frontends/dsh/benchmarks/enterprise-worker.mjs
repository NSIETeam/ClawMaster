/** Plain Node worker exercising the production enterprise store with synthetic records. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { openEnterpriseStore } from '../src/enterprise-host.ts';

const [mode, databasePath, countText] = process.argv.slice(2);
const count = Number(countText);
assert.ok(databasePath && Number.isSafeInteger(count) && count > 0);
const contact = index => ({
  id: `contact-${index}`, name: `Contact ${String(index).padStart(6, '0')}`, company: `Company ${index % 20}`,
  stage: 'proposal', nextAction: 'Review the synthetic proposal', nextActionDate: '2026-09-20',
});
let store;
let revision = 0;
const execute = command => {
  const receipt = store.executeReceipt({ generation: 0, revision, commandId: `command-${revision + 1}`, command });
  revision = receipt.revision;
  return receipt;
};
try {
  if (mode === 'seed') {
    store = await openEnterpriseStore(databasePath);
    for (let index = 0; index < count; index++) {
      execute({ type: 'contact.upsert', contact: contact(index) });
      execute({ type: 'item.upsert', item: {
        id: `item-${index}`, sku: `SKU-${index}`, name: `Item ${index}`, stock: 1000, reorderAt: 10, supplier: `Supplier ${index % 10}`,
      } });
      execute({ type: 'order.save', order: {
        id: `order-${index}`, kind: 'sale', counterparty: `Company ${index % 20}`, orderDate: '2026-09-16', currency: 'CNY',
        lines: [{ itemId: `item-${index}`, quantity: 2, unitPriceMinorUnits: 12345 }], note: 'Synthetic draft',
      } });
      for (let edit = 0; edit < 2; edit++) execute({ type: 'contact.upsert', contact: { ...contact(index), nextAction: `Review ${edit}` } });
    }
    process.stdout.write(JSON.stringify({ revision, recordsPerCollection: count }));
  } else {
    assert.equal(mode, 'sample');
    const samples = {};
    const measure = async (name, operation, serialize = true) => {
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
        const encoded = serialize ? JSON.stringify(result) : undefined;
        const elapsedMs = performance.now() - started;
        const retained = process.memoryUsage();
        finished = true;
        samples[name] = {
          elapsedMs, eventLoopRoundtripMs: await eventLoop,
          responseBytes: encoded === undefined ? null : Buffer.byteLength(encoded),
          rssBeforeBytes: before.rss, rssAfterBytes: retained.rss, heapAfterBytes: retained.heapUsed,
        };
        return result;
      } finally {
        finished = true;
        await eventLoop;
      }
    };
    store = await measure('open', () => openEnterpriseStore(databasePath), false);
    const page = await measure('list', () => store.queryPage({ collection: 'contacts', offset: 0, limit: 50 }, 64 * 1024));
    assert.equal(page.total, count);
    assert.equal(page.records.length, Math.min(50, count));
    revision = page.revision;
    assert.equal(revision, count * 5);
    await measure('search', () => store.queryPage({ collection: 'contacts', offset: 0, limit: 50, search: 'Company 7' }, 64 * 1024));
    const audit = await measure('auditTail', () => store.queryPage({ collection: 'audit', offset: Math.max(0, revision - 50), limit: 50 }, 64 * 1024));
    assert.equal(audit.total, revision);
    await measure('saveReceipt', () => execute({ type: 'contact.upsert', contact: { ...contact(0), nextAction: 'Measured update' } }));
    {
      const snapshot = await measure('snapshot', () => store.snapshot());
      assert.equal(snapshot.contacts.length, count);
      assert.equal(snapshot.audit.length, count * 5 + 1);
    }
    const backup = await measure('backup', () => store.backup());
    const restored = await measure('restore', () => store.restore(backup, revision, 0));
    assert.equal(restored.contacts.length, count);
    assert.equal(restored.generation, 1);
    process.stdout.write(JSON.stringify({ samples, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
  }
} finally {
  store?.close();
}
