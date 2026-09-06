import { describe, expect, it } from 'vitest';
import {
  calculateCashPosition,
  calculateGrowth,
  calculateInventory,
  type CashSnapshot,
  type GrowthLine,
  type InventoryLine,
} from './operatingEngines.js';

const evidence = {
  observedAt: '2026-09-06T00:00:00.000Z',
  source: 'connector-test',
  sourceRevision: 'r1',
  staleAfterMs: 24 * 60 * 60 * 1_000,
  evidenceRefs: ['event:test:1'],
};

const inventory = (overrides: Partial<InventoryLine> = {}): InventoryLine => ({
  ...evidence,
  organizationId: 'org-1', skuId: 'sku-1', warehouseId: 'warehouse-1',
  onHandUnits: 280n, trailing28DayUnitsSold: 140n,
  unitCost: { currency: 'CNY', minorUnits: 2_500n },
  ...overrides,
});

const cash = (overrides: Partial<CashSnapshot> = {}): CashSnapshot => ({
  ...evidence,
  organizationId: 'org-1',
  cash: { currency: 'CNY', minorUnits: 3_000_000n },
  receivables: { currency: 'CNY', minorUnits: 1_000_000n },
  overdueReceivables: { currency: 'CNY', minorUnits: 400_000n },
  payables: { currency: 'CNY', minorUnits: 800_000n },
  trailing30DayOperatingOutflow: { currency: 'CNY', minorUnits: 1_500_000n },
  ...overrides,
});

const growth = (overrides: Partial<GrowthLine> = {}): GrowthLine => ({
  ...evidence,
  organizationId: 'org-1', channelId: 'tmall', skuId: 'sku-1',
  currentRevenue: { currency: 'CNY', minorUnits: 1_200_000n },
  previousRevenue: { currency: 'CNY', minorUnits: 1_000_000n },
  currentContributionMargin: { currency: 'CNY', minorUnits: 180_000n },
  previousContributionMargin: { currency: 'CNY', minorUnits: 200_000n },
  attributionAssumption: 'last-click platform report',
  ...overrides,
});

describe('Inventory Engine', () => {
  it('calculates inventory value and integer days of cover', () => {
    const result = calculateInventory([inventory()], '2026-09-06T12:00:00.000Z');
    expect(result).toMatchObject({
      organizationId: 'org-1', status: 'known', daysCover: 56,
      inventoryValue: { currency: 'CNY', minorUnits: 700_000n },
    });
    expect(result.evidenceRefs).toEqual(['event:test:1']);
  });

  it('keeps value or cover partial when cost or demand is missing', () => {
    const result = calculateInventory([
      inventory({ unitCost: undefined, trailing28DayUnitsSold: undefined }),
    ], '2026-09-06T12:00:00.000Z');
    expect(result.status).toBe('partial');
    expect(result.inventoryValue).toBeUndefined();
    expect(result.daysCover).toBeUndefined();
    expect(result.missing).toEqual(['inventory_cost', 'trailing_demand']);
    expect(result.risks).toContain('库存金额未知：单位成本缺失');
  });

  it('does not call zero recent demand a known inventory cover', () => {
    const result = calculateInventory([
      inventory({ trailing28DayUnitsSold: 0n }),
    ], '2026-09-06T12:00:00.000Z');
    expect(result.status).toBe('partial');
    expect(result.daysCover).toBeUndefined();
    expect(result.missing).toContain('positive_trailing_demand');
    expect(result.risks).toContain('近28日无销量但仍有库存');
  });

  it('rejects mixed tenants and currencies instead of aggregating them', () => {
    expect(() => calculateInventory([
      inventory(), inventory({ organizationId: 'org-2' }),
    ], '2026-09-06T12:00:00.000Z')).toThrow('organization_mismatch');
    expect(() => calculateInventory([
      inventory(), inventory({ unitCost: { currency: 'USD', minorUnits: 1n } }),
    ], '2026-09-06T12:00:00.000Z')).toThrow('currency_mismatch');
  });

  it('rejects negative unit cost and missing evidence', () => {
    expect(() => calculateInventory([
      inventory({ unitCost: { currency: 'CNY', minorUnits: -1n } }),
    ], '2026-09-06T12:00:00.000Z')).toThrow('invalid_inventory_cost');
    expect(() => calculateInventory([
      inventory({ evidenceRefs: [] }),
    ], '2026-09-06T12:00:00.000Z')).toThrow('evidence_required');
  });
});

describe('Cash Engine', () => {
  it('calculates runway and flags overdue receivable concentration', () => {
    const result = calculateCashPosition(cash(), '2026-09-06T12:00:00.000Z');
    expect(result).toMatchObject({
      status: 'known', runwayDays: 60,
      netWorkingCapital: { currency: 'CNY', minorUnits: 3_200_000n },
      overdueReceivablesBps: 4_000,
    });
    expect(result.risks).toContain('逾期应收占比超过30%');
  });

  it('never invents runway when operating outflow is missing', () => {
    const result = calculateCashPosition(
      cash({ trailing30DayOperatingOutflow: undefined }),
      '2026-09-06T12:00:00.000Z',
    );
    expect(result.status).toBe('partial');
    expect(result.runwayDays).toBeUndefined();
    expect(result.missing).toContain('operating_outflow');
    expect(result.risks).toContain('现金 runway 未知：近30日经营流出缺失');
  });

  it('does not call zero operating outflow a finite known runway', () => {
    const result = calculateCashPosition(
      cash({ trailing30DayOperatingOutflow: { currency: 'CNY', minorUnits: 0n } }),
      '2026-09-06T12:00:00.000Z',
    );
    expect(result.status).toBe('partial');
    expect(result.runwayDays).toBeUndefined();
    expect(result.missing).toContain('positive_operating_outflow');
  });

  it('rejects negative operating balances other than cash', () => {
    expect(() => calculateCashPosition(
      cash({ receivables: { currency: 'CNY', minorUnits: -1n } }),
      '2026-09-06T12:00:00.000Z',
    )).toThrow('invalid_receivables');
    expect(() => calculateCashPosition(
      cash({ payables: { currency: 'CNY', minorUnits: -1n } }),
      '2026-09-06T12:00:00.000Z',
    )).toThrow('invalid_payables');
    expect(() => calculateCashPosition(
      cash({ trailing30DayOperatingOutflow: { currency: 'CNY', minorUnits: -1n } }),
      '2026-09-06T12:00:00.000Z',
    )).toThrow('invalid_operating_outflow');
  });
});

describe('Growth Engine', () => {
  it('does not call revenue growth profitable when contribution declines', () => {
    const result = calculateGrowth([growth()], '2026-09-06T12:00:00.000Z');
    expect(result).toMatchObject({
      status: 'known', revenueGrowthBps: 2_000,
      contributionGrowthBps: -1_000, attribution: 'hypothesis',
      attributionAssumptions: ['last-click platform report'],
    });
    expect(result.risks).toContain('收入增长但贡献利润下降');
    expect(result.opportunities).toEqual([]);
  });

  it('marks contribution and attribution unknown when evidence is incomplete', () => {
    const result = calculateGrowth([
      growth({ currentContributionMargin: undefined, attributionAssumption: undefined }),
    ], '2026-09-06T12:00:00.000Z');
    expect(result.status).toBe('partial');
    expect(result.contributionGrowthBps).toBeUndefined();
    expect(result.attribution).toBe('unknown');
    expect(result.missing).toEqual(['contribution_margin', 'attribution_assumption']);
  });

  it('makes stale source data visible instead of returning a healthy signal', () => {
    const result = calculateGrowth([growth()], '2026-09-08T00:00:00.000Z');
    expect(result.stale).toBe(true);
    expect(result.risks).toContain('增长数据已过期');
  });
});
