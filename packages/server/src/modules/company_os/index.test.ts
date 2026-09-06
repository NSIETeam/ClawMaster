import { describe, expect, it } from 'vitest';
import { BrandWatchdog, InMemoryEventBus, buildCeoBrief, calculateProfit, createCanonicalEvent, type ProfitLine } from './index.js';

const freshness = { observedAt: '2026-09-05T00:00:00.000Z', source: 'test', sourceRevision: 'r1' };
const line = (overrides: Partial<ProfitLine> = {}): ProfitLine => ({
  ...freshness, organizationId: 'org-1', skuId: 'sku-1', channelId: 'channel-1', revenue: { currency: 'CNY', minorUnits: 10000n },
  cost: { currency: 'CNY', minorUnits: 4000n }, commission: { currency: 'CNY', minorUnits: 1000n }, advertising: { currency: 'CNY', minorUnits: 1000n }, fulfillment: { currency: 'CNY', minorUnits: 500n }, ...overrides,
});

describe('Brand AI COO vertical slice', () => {
  it('calculates contribution margin with integer money and no floating point', () => {
    const result = calculateProfit([line()]);
    expect(result.status).toBe('known');
    expect(result.contributionMargin?.minorUnits).toBe(3500n);
    expect(result.marginBps).toBe(3500);
  });

  it('keeps margin unknown when any required cost is absent', () => {
    const result = calculateProfit([line({ advertising: undefined })]);
    expect(result.status).toBe('unknown');
    expect(result.contributionMargin).toBeUndefined();
    expect(result.missing).toEqual(['cost']);
    expect(buildCeoBrief('org-1', result, []).risks[0]).toContain('利润未知');
  });

  it('deduplicates inbound facts but supports at-least-once consumer delivery', () => {
    const bus = new InMemoryEventBus();
    const event = createCanonicalEvent({ ...freshness, organizationId: 'org-1', type: 'zhilemon.gmv.anomaly', payload: { deltaBps: -1700 }, correlationId: 'c1', idempotencyKey: 'gmv-1' });
    bus.publish(event); bus.publish({ ...event, id: 'duplicate' });
    expect(bus.events).toHaveLength(1);
    expect(bus.consume('consumer', () => undefined)).toBe(1);
    expect(bus.consume('consumer', () => undefined)).toBe(0);
  });

  it('turns owl/zhilemon signals into an evidence-linked action and audit', () => {
    const bus = new InMemoryEventBus();
    bus.publish(createCanonicalEvent({ ...freshness, organizationId: 'org-1', type: 'owl.price.anomaly', payload: { skuId: 'sku-1' }, correlationId: 'c2', idempotencyKey: 'price-1' }));
    const watchdog = new BrandWatchdog(bus, () => freshness.observedAt);
    expect(watchdog.inspect()).toBe(1);
    expect(watchdog.actions[0].evidenceEventIds).toEqual([bus.events[0].id]);
    expect(watchdog.audit[0].status).toBe('recommended');
    expect(buildCeoBrief('org-1', calculateProfit([line()]), watchdog.actions).recommendedActions).toHaveLength(1);
  });

  it('isolates organization data in the CEO brief', () => {
    const bus = new InMemoryEventBus();
    bus.publish(createCanonicalEvent({ ...freshness, organizationId: 'org-2', type: 'owl.price.anomaly', payload: {}, correlationId: 'c3', idempotencyKey: 'price-2' }));
    const watchdog = new BrandWatchdog(bus); watchdog.inspect();
    expect(buildCeoBrief('org-1', calculateProfit([line()]), watchdog.actions).recommendedActions).toHaveLength(0);
  });

  it('rejects mixed-tenant profit input instead of aggregating it', () => {
    expect(() => calculateProfit([
      line(),
      line({ organizationId: 'org-2' }),
    ])).toThrow('organization_mismatch');
  });

  it('rejects an idempotency key reused for a different fact', () => {
    const bus = new InMemoryEventBus();
    const event = createCanonicalEvent({
      ...freshness, organizationId: 'org-1', type: 'owl.price.anomaly',
      payload: { skuId: 'sku-1' }, correlationId: 'c4', idempotencyKey: 'price-3',
    });
    bus.publish(event);
    expect(() => bus.publish({ ...event, payload: { skuId: 'sku-2' } }))
      .toThrow('idempotency_conflict');
  });

  it('does not let matching external event ids collide across tenants', () => {
    const bus = new InMemoryEventBus();
    bus.publish(createCanonicalEvent({
      ...freshness, id: 'provider-event-1', organizationId: 'org-1',
      type: 'owl.price.anomaly', payload: {}, correlationId: 'c5', idempotencyKey: 'price-4',
    }));
    bus.publish(createCanonicalEvent({
      ...freshness, id: 'provider-event-1', organizationId: 'org-2',
      type: 'owl.price.anomaly', payload: {}, correlationId: 'c6', idempotencyKey: 'price-5',
    }));
    expect(bus.consume('brand-watchdog', () => undefined)).toBe(2);
  });
});
