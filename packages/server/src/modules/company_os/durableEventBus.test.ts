import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import {
  COMPANY_OS_SCHEMA_CONTRIBUTOR,
  DurableBrandWatchdog,
  DurableCompanyOsEventBus,
  createCanonicalEvent,
  type CanonicalEvent,
} from './index.js';

const databases: Database[] = [];
const freshness = {
  observedAt: '2026-09-06T00:00:00.000Z',
  source: 'connector-test',
  sourceRevision: 'r1',
};

function database(): Database {
  const result = new Database(':memory:');
  databases.push(result);
  return result;
}

function event(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return createCanonicalEvent({
    ...freshness,
    organizationId: 'org-1',
    type: 'owl.price.anomaly',
    payload: { skuId: 'sku-1', values: { current: 90, expected: 100 } },
    correlationId: 'correlation-1',
    idempotencyKey: 'price-1',
    ...overrides,
  });
}

afterEach(() => {
  for (const entry of databases.splice(0)) entry.close();
});

describe('durable CompanyOS event bus', () => {
  it('creates tenant-scoped event and receipt tables', () => {
    const db = database();
    COMPANY_OS_SCHEMA_CONTRIBUTOR.apply(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'companyos_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'companyos_actions',
      'companyos_audit',
      'companyos_event_receipts',
      'companyos_events',
    ]);
  });

  it('persists receipts across bus instances and replays only unacknowledged events', () => {
    const db = database();
    let now = 1;
    const store = { db: () => db, now: () => now++ };
    const first = new DurableCompanyOsEventBus(store);
    first.publish(event());
    expect(first.consume('watchdog', () => undefined)).toBe(1);

    const restarted = new DurableCompanyOsEventBus(store);
    expect(restarted.consume('watchdog', () => undefined)).toBe(0);
    expect(restarted.consume('brief-projector', () => undefined)).toBe(1);
  });

  it('does not acknowledge an event when its handler fails', () => {
    const db = database();
    const bus = new DurableCompanyOsEventBus({ db: () => db, now: () => 1 });
    bus.publish(event());
    expect(() => bus.consume('watchdog', () => { throw new Error('crash'); }))
      .toThrow('crash');
    expect(bus.consume('watchdog', () => undefined)).toBe(1);
  });

  it('deduplicates reordered facts but rejects conflicting idempotency payloads', () => {
    const db = database();
    const bus = new DurableCompanyOsEventBus({ db: () => db, now: () => 1 });
    const original = event();
    expect(bus.publish(original)).toEqual(original);
    expect(bus.publish({
      ...original,
      payload: { values: { expected: 100, current: 90 }, skuId: 'sku-1' },
    })).toEqual(original);
    expect(() => bus.publish({ ...original, payload: { skuId: 'sku-2' } }))
      .toThrow('idempotency_conflict');
  });

  it('keeps matching external ids and idempotency keys isolated by organization', () => {
    const db = database();
    const bus = new DurableCompanyOsEventBus({ db: () => db, now: () => 1 });
    bus.publish(event({ id: 'external-1' }));
    bus.publish(event({
      id: 'external-1',
      organizationId: 'org-2',
      correlationId: 'correlation-2',
    }));
    const organizations: string[] = [];
    expect(bus.consume('watchdog', (item) => organizations.push(item.organizationId))).toBe(2);
    expect(organizations).toEqual(['org-1', 'org-2']);
  });

  it('persists one evidence-linked action and audit record across replay', () => {
    const db = database();
    let now = Date.parse('2026-09-06T01:00:00.000Z');
    const store = { db: () => db, now: () => now++ };
    const bus = new DurableCompanyOsEventBus(store);
    bus.publish(event());
    const watchdog = new DurableBrandWatchdog(store, bus);
    expect(watchdog.inspect()).toBe(1);
    expect(watchdog.listActions('org-1')).toEqual([
      expect.objectContaining({
        organizationId: 'org-1',
        status: 'recommended',
        evidenceEventIds: ['org-1:price-1'],
      }),
    ]);
    expect(watchdog.listAudit('org-1')).toEqual([
      expect.objectContaining({
        organizationId: 'org-1',
        action: 'watchdog.recommendation.created',
        actor: 'brand-ceo-agent',
        evidenceEventIds: ['org-1:price-1'],
      }),
    ]);

    db.prepare("DELETE FROM companyos_event_receipts WHERE consumer_id = 'brand-watchdog-v1'").run();
    expect(new DurableBrandWatchdog(store, bus).inspect()).toBe(1);
    expect(watchdog.listActions('org-1')).toHaveLength(1);
    expect(watchdog.listAudit('org-1')).toHaveLength(1);
  });

  it('acknowledges non-actionable facts without creating fake actions', () => {
    const db = database();
    const store = { db: () => db, now: () => 1 };
    const bus = new DurableCompanyOsEventBus(store);
    bus.publish(event({ type: 'inventory.snapshot' }));
    const watchdog = new DurableBrandWatchdog(store, bus);
    expect(watchdog.inspect()).toBe(1);
    expect(watchdog.listActions('org-1')).toEqual([]);
    expect(watchdog.listAudit('org-1')).toEqual([]);
  });
});
