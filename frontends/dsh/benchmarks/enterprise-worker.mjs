/** Plain Node worker exercising the production enterprise store with synthetic records. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
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
