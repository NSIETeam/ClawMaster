import { describe, expect, it } from 'vitest';
import { createCanonicalEvent, type CanonicalEvent } from './index.js';
import { buildOperatingBrief } from './operatingBrief.js';

function event(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<CanonicalEvent> = {},
): CanonicalEvent {
  return createCanonicalEvent({
    organizationId: 'org-1', type, payload,
    source: 'connector-test', sourceRevision: 'r1',
    observedAt: '2026-09-06T00:00:00.000Z', staleAfterMs: 86_400_000,
    correlationId: 'brief-1', idempotencyKey: `${type}:${JSON.stringify(payload)}`,
    ...overrides,
  });
}

const money = (minorUnits: string) => ({ currency: 'CNY', minorUnits });

function completeEvents(): CanonicalEvent[] {
  return [
    event('companyos.profit.line.v1', {
      skuId: 'sku-1', channelId: 'tmall', revenue: money('10000'),
      cost: money('4000'), commission: money('1000'), advertising: money('1000'),
      fulfillment: money('500'), refunds: money('0'),
    }),
    event('companyos.inventory.line.v1', {
      skuId: 'sku-1', warehouseId: 'warehouse-1', onHandUnits: '280',
      trailing28DayUnitsSold: '140', unitCost: money('2500'),
    }),
    event('companyos.cash.snapshot.v1', {
      cash: money('3000000'), receivables: money('1000000'),
      overdueReceivables: money('400000'), payables: money('800000'),
      trailing30DayOperatingOutflow: money('1500000'),
    }),
    event('companyos.growth.line.v1', {
      channelId: 'tmall', skuId: 'sku-1', currentRevenue: money('1200000'),
      previousRevenue: money('1000000'), currentContributionMargin: money('180000'),
      previousContributionMargin: money('200000'),
      attributionAssumption: 'last-click platform report',
    }),
  ];
}

describe('CompanyOS operating brief', () => {
  it('builds all five metrics with JSON-safe integer strings and evidence', () => {
    const brief = buildOperatingBrief({
      organizationId: 'org-1', events: completeEvents(), actions: [],
      asOf: '2026-09-06T12:00:00.000Z',
    });
    expect(brief.status).toBe('known');
    expect(brief.metrics.revenue.amount).toEqual(money('10000'));
    expect(brief.metrics.margin).toMatchObject({
      amount: money('3500'), basisPoints: 3500, status: 'known',
    });
    expect(brief.metrics.inventory).toMatchObject({
      value: money('700000'), daysCover: 56, status: 'known',
    });
    expect(brief.metrics.cash).toMatchObject({
      balance: money('3000000'), runwayDays: 60, status: 'known',
    });
    expect(brief.metrics.growth).toMatchObject({
      revenueGrowthBps: 2000, contributionGrowthBps: -1000, status: 'known',
    });
    expect(JSON.stringify(brief)).toContain('3000000');
    expect(brief.evidenceRefs).toHaveLength(4);
  });

  it('keeps absent metrics unknown instead of substituting zero', () => {
    const brief = buildOperatingBrief({
      organizationId: 'org-1', events: [], actions: [],
      asOf: '2026-09-06T12:00:00.000Z',
    });
    expect(brief.status).toBe('unknown');
    expect(brief.metrics.revenue.amount).toBeNull();
    expect(brief.metrics.margin.amount).toBeNull();
    expect(brief.metrics.inventory.value).toBeNull();
    expect(brief.metrics.cash.balance).toBeNull();
    expect(brief.metrics.growth.revenueGrowthBps).toBeNull();
    expect(brief.missing).toEqual(['cash', 'growth', 'inventory', 'profit']);
  });

  it('uses the latest observed fact for the same business key', () => {
    const oldInventory = completeEvents()[1]!;
    const latestInventory = event('companyos.inventory.line.v1', {
      skuId: 'sku-1', warehouseId: 'warehouse-1', onHandUnits: '140',
      trailing28DayUnitsSold: '140', unitCost: money('2500'),
    }, {
      id: 'inventory-latest', idempotencyKey: 'inventory-latest',
      observedAt: '2026-09-06T01:00:00.000Z', sourceRevision: 'r2',
    });
    const brief = buildOperatingBrief({
      organizationId: 'org-1', events: [oldInventory, latestInventory], actions: [],
      asOf: '2026-09-06T12:00:00.000Z',
    });
    expect(brief.metrics.inventory.value).toEqual(money('350000'));
    expect(brief.metrics.inventory.daysCover).toBe(28);
    expect(brief.metrics.inventory.evidenceRefs).toEqual(['inventory-latest']);
  });

  it('isolates malformed facts and exposes them as contract risk', () => {
    const malformed = event('companyos.cash.snapshot.v1', {
      cash: { currency: 'CNY', minorUnits: 3_000_000 },
    });
    const brief = buildOperatingBrief({
      organizationId: 'org-1', events: [malformed], actions: [],
      asOf: '2026-09-06T12:00:00.000Z',
    });
    expect(brief.status).toBe('unknown');
    expect(brief.invalidEvidenceRefs).toEqual([malformed.id]);
    expect(brief.risks).toContain('经营事实契约无效：1 条事件未纳入计算');
  });

  it('keeps malformed profit missing and rejects future evidence time', () => {
    const malformedProfit = event('companyos.profit.line.v1', {
      skuId: 'sku-1', channelId: 'tmall', revenue: money('not-an-integer'),
    });
    const brief = buildOperatingBrief({
      organizationId: 'org-1', events: [malformedProfit], actions: [],
      asOf: '2026-09-06T12:00:00.000Z',
    });
    expect(brief.metrics.revenue.amount).toBeNull();
    expect(brief.missing).toContain('profit');
    const future = event('companyos.cash.snapshot.v1', { cash: money('1') }, {
      id: 'future-cash', observedAt: '2026-09-07T00:00:00.000Z',
    });
    const futureBrief = buildOperatingBrief({
      organizationId: 'org-1', events: [future], actions: [],
      asOf: '2026-09-06T12:00:00.000Z',
    });
    expect(futureBrief.metrics.cash.balance).toBeNull();
    expect(futureBrief.invalidEvidenceRefs).toEqual(['future-cash']);
  });

  it('keeps known revenue visible when margin costs are incomplete', () => {
    const incomplete = event('companyos.profit.line.v1', {
      skuId: 'sku-1', channelId: 'tmall', revenue: money('10000'),
    });
    const brief = buildOperatingBrief({
      organizationId: 'org-1', events: [incomplete], actions: [],
      asOf: '2026-09-06T12:00:00.000Z',
    });
    expect(brief.metrics.revenue).toMatchObject({ status: 'known', amount: money('10000') });
    expect(brief.metrics.margin).toMatchObject({ status: 'unknown', amount: null });
  });

  it('turns cross-event currency conflicts into invalid evidence, not an API crash', () => {
    const events = [
      completeEvents()[1]!,
      event('companyos.inventory.line.v1', {
        skuId: 'sku-2', warehouseId: 'warehouse-1', onHandUnits: '1',
        trailing28DayUnitsSold: '1', unitCost: { currency: 'USD', minorUnits: '1' },
      }, { id: 'inventory-usd', idempotencyKey: 'inventory-usd' }),
    ];
    const brief = buildOperatingBrief({
      organizationId: 'org-1', events, actions: [],
      asOf: '2026-09-06T12:00:00.000Z',
    });
    expect(brief.metrics.inventory.status).toBe('unknown');
    expect(brief.invalidEvidenceRefs).toEqual(expect.arrayContaining(events.map((item) => item.id)));
  });

  it('downgrades a complete but stale brief instead of calling it known', () => {
    const brief = buildOperatingBrief({
      organizationId: 'org-1', events: completeEvents(), actions: [],
      asOf: '2026-09-08T00:00:00.000Z',
    });
    expect(brief.status).toBe('partial');
    expect(brief.metrics.revenue.stale).toBe(true);
    expect(brief.risks).toEqual(expect.arrayContaining([
      '经营数据已过期，不能作为当前健康状态',
    ]));
  });

  it('rejects events from another tenant before aggregation', () => {
    expect(() => buildOperatingBrief({
      organizationId: 'org-1',
      events: [event('companyos.cash.snapshot.v1', { cash: money('1') }, {
        organizationId: 'org-2',
      })],
      actions: [], asOf: '2026-09-06T12:00:00.000Z',
    })).toThrow('organization_mismatch');
  });
});
