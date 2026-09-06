/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import type { DataFreshness, Money } from './index.js';

export type EngineStatus = 'known' | 'partial' | 'unknown';

export type EvidenceFreshness = DataFreshness & {
  evidenceRefs: readonly string[];
};

export type InventoryLine = EvidenceFreshness & {
  organizationId: string;
  skuId: string;
  warehouseId: string;
  onHandUnits: bigint;
  trailing28DayUnitsSold?: bigint;
  unitCost?: Money;
};

export interface InventoryResult {
  organizationId: string;
  status: EngineStatus;
  currency: string;
  inventoryValue?: Money;
  daysCover?: number;
  missing: string[];
  risks: string[];
  stale: boolean;
  evidenceRefs: string[];
  sources: Array<{ source: string; sourceRevision: string; observedAt: string }>;
}

export type CashSnapshot = EvidenceFreshness & {
  organizationId: string;
  cash: Money;
  receivables?: Money;
  overdueReceivables?: Money;
  payables?: Money;
  trailing30DayOperatingOutflow?: Money;
};

export interface CashResult {
  organizationId: string;
  status: EngineStatus;
  currency: string;
  cash: Money;
  netWorkingCapital?: Money;
  runwayDays?: number;
  overdueReceivablesBps?: number;
  missing: string[];
  risks: string[];
  stale: boolean;
  evidenceRefs: string[];
  sources: Array<{ source: string; sourceRevision: string; observedAt: string }>;
}

export type GrowthLine = EvidenceFreshness & {
  organizationId: string;
  channelId: string;
  skuId?: string;
  campaignId?: string;
  currentRevenue: Money;
  previousRevenue: Money;
  currentContributionMargin?: Money;
  previousContributionMargin?: Money;
  attributionAssumption?: string;
};

export interface GrowthResult {
  organizationId: string;
  status: EngineStatus;
  currency: string;
  revenueGrowthBps?: number;
  contributionGrowthBps?: number;
  attribution: 'observed' | 'hypothesis' | 'unknown';
  attributionAssumptions: string[];
  missing: string[];
  risks: string[];
  opportunities: string[];
  stale: boolean;
  evidenceRefs: string[];
  sources: Array<{ source: string; sourceRevision: string; observedAt: string }>;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw new Error(`invalid_${field}`);
  return normalized;
}

function requireMoney(value: Money, currency?: string): Money {
  const normalizedCurrency = requireText(value.currency, 'currency');
  if (currency !== undefined && normalizedCurrency !== currency) {
    throw new Error('currency_mismatch');
  }
  if (typeof value.minorUnits !== 'bigint') throw new Error('invalid_minor_units');
  return { currency: normalizedCurrency, minorUnits: value.minorUnits };
}

function asOfMilliseconds(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('invalid_as_of');
  return milliseconds;
}

function sourceEvidence(
  records: readonly EvidenceFreshness[],
  asOf: number,
): {
  stale: boolean;
  evidenceRefs: string[];
  sources: Array<{ source: string; sourceRevision: string; observedAt: string }>;
} {
  const evidenceRefs = new Set<string>();
  const sources = new Map<string, { source: string; sourceRevision: string; observedAt: string }>();
  let stale = false;
  for (const record of records) {
    const source = requireText(record.source, 'source');
    const sourceRevision = requireText(record.sourceRevision, 'source_revision');
    const observedAtMs = Date.parse(record.observedAt);
    if (!Number.isFinite(observedAtMs) || observedAtMs > asOf) {
      throw new Error('invalid_observed_at');
    }
    if (record.staleAfterMs !== undefined) {
      if (!Number.isSafeInteger(record.staleAfterMs) || record.staleAfterMs < 0) {
        throw new Error('invalid_stale_after_ms');
      }
      if (observedAtMs + record.staleAfterMs <= asOf) stale = true;
    }
    if (!record.evidenceRefs.length) throw new Error('evidence_required');
    for (const reference of record.evidenceRefs) {
      evidenceRefs.add(requireText(reference, 'evidence_ref'));
    }
    sources.set(`${source}\0${sourceRevision}\0${record.observedAt}`, {
      source, sourceRevision, observedAt: record.observedAt,
    });
  }
  return {
    stale,
    evidenceRefs: [...evidenceRefs].sort(),
    sources: [...sources.values()].sort((left, right) => (
      left.observedAt.localeCompare(right.observedAt)
      || left.source.localeCompare(right.source)
    )),
  };
}

function ratioBps(current: bigint, previous: bigint): number | undefined {
  if (previous === 0n) return undefined;
  const value = (current - previous) * 10_000n / (previous < 0n ? -previous : previous);
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new Error('ratio_overflow');
  return converted;
}

function integerRatio(numerator: bigint, denominator: bigint): number | undefined {
  if (denominator <= 0n) return undefined;
  const converted = Number(numerator / denominator);
  if (!Number.isSafeInteger(converted)) throw new Error('ratio_overflow');
  return converted;
}

export function calculateInventory(
  lines: readonly InventoryLine[],
  asOf: string,
): InventoryResult {
  const asOfMs = asOfMilliseconds(asOf);
  if (!lines.length) {
    return {
      organizationId: 'UNKNOWN', status: 'unknown', currency: 'UNKNOWN',
      missing: ['inventory'], risks: ['库存未知：没有可用数据'], stale: false,
      evidenceRefs: [], sources: [],
    };
  }
  const organizationId = requireText(lines[0]!.organizationId, 'organization_id');
  let currency: string | undefined;
  let onHandUnits = 0n;
  let demandUnits = 0n;
  let inventoryValue = 0n;
  let missingCost = false;
  let missingDemand = false;
  for (const line of lines) {
    if (requireText(line.organizationId, 'organization_id') !== organizationId) {
      throw new Error('organization_mismatch');
    }
    requireText(line.skuId, 'sku_id');
    requireText(line.warehouseId, 'warehouse_id');
    if (line.onHandUnits < 0n) throw new Error('invalid_inventory_units');
    onHandUnits += line.onHandUnits;
    if (line.unitCost === undefined) missingCost = true;
    else {
      const cost = requireMoney(line.unitCost, currency);
      if (cost.minorUnits < 0n) throw new Error('invalid_inventory_cost');
      currency ??= cost.currency;
      inventoryValue += line.onHandUnits * cost.minorUnits;
    }
    if (line.trailing28DayUnitsSold === undefined) missingDemand = true;
    else {
      if (line.trailing28DayUnitsSold < 0n) throw new Error('invalid_demand_units');
      demandUnits += line.trailing28DayUnitsSold;
    }
  }
  const evidence = sourceEvidence(lines, asOfMs);
  const missing = [
    ...(missingCost ? ['inventory_cost'] : []),
    ...(missingDemand ? ['trailing_demand'] : []),
    ...(!missingDemand && demandUnits === 0n && onHandUnits > 0n
      ? ['positive_trailing_demand'] : []),
  ];
  const daysCover = missingDemand ? undefined : integerRatio(onHandUnits * 28n, demandUnits);
  const risks: string[] = [];
  if (missingCost) risks.push('库存金额未知：单位成本缺失');
  if (missingDemand) risks.push('库存周转未知：近28日需求缺失');
  else if (demandUnits === 0n && onHandUnits > 0n) risks.push('近28日无销量但仍有库存');
  else if ((daysCover ?? 0) > 90) risks.push('库存覆盖超过90天');
  if (evidence.stale) risks.push('库存数据已过期');
  return {
    organizationId,
    status: missing.length ? 'partial' : 'known',
    currency: currency ?? 'UNKNOWN',
    ...(missingCost ? {} : { inventoryValue: { currency: currency!, minorUnits: inventoryValue } }),
    ...(daysCover === undefined ? {} : { daysCover }),
    missing, risks, ...evidence,
  };
}

export function calculateCashPosition(snapshot: CashSnapshot, asOf: string): CashResult {
  const asOfMs = asOfMilliseconds(asOf);
  const organizationId = requireText(snapshot.organizationId, 'organization_id');
  const cash = requireMoney(snapshot.cash);
  const optionalMoney = [
    snapshot.receivables,
    snapshot.overdueReceivables,
    snapshot.payables,
    snapshot.trailing30DayOperatingOutflow,
  ].map((value) => value === undefined ? undefined : requireMoney(value, cash.currency));
  const [receivables, overdueReceivables, payables, outflow] = optionalMoney;
  if (receivables && receivables.minorUnits < 0n) throw new Error('invalid_receivables');
  if (overdueReceivables && overdueReceivables.minorUnits < 0n) {
    throw new Error('invalid_overdue_receivables');
  }
  if (payables && payables.minorUnits < 0n) throw new Error('invalid_payables');
  if (outflow && outflow.minorUnits < 0n) throw new Error('invalid_operating_outflow');
  const missing = [
    ...(receivables === undefined ? ['receivables'] : []),
    ...(overdueReceivables === undefined ? ['overdue_receivables'] : []),
    ...(payables === undefined ? ['payables'] : []),
    ...(outflow === undefined ? ['operating_outflow'] : []),
    ...(outflow !== undefined && outflow.minorUnits === 0n
      ? ['positive_operating_outflow'] : []),
  ];
  const netWorkingCapital = receivables && payables
    ? { currency: cash.currency, minorUnits: cash.minorUnits + receivables.minorUnits - payables.minorUnits }
    : undefined;
  const runwayDays = outflow ? integerRatio(cash.minorUnits * 30n, outflow.minorUnits) : undefined;
  const overdueReceivablesBps = receivables && overdueReceivables
    ? integerRatio(overdueReceivables.minorUnits * 10_000n, receivables.minorUnits)
    : undefined;
  const evidence = sourceEvidence([snapshot], asOfMs);
  const risks: string[] = [];
  if (outflow === undefined) risks.push('现金 runway 未知：近30日经营流出缺失');
  else if (outflow.minorUnits <= 0n) risks.push('近30日经营流出非正，runway 无法有限估计');
  else if ((runwayDays ?? Number.MAX_SAFE_INTEGER) < 90) risks.push('现金 runway 低于90天');
  if ((overdueReceivablesBps ?? 0) > 3_000) risks.push('逾期应收占比超过30%');
  if (cash.minorUnits < 0n) risks.push('现金余额为负');
  if (evidence.stale) risks.push('现金数据已过期');
  return {
    organizationId, status: missing.length ? 'partial' : 'known',
    currency: cash.currency, cash,
    ...(netWorkingCapital ? { netWorkingCapital } : {}),
    ...(runwayDays === undefined ? {} : { runwayDays }),
    ...(overdueReceivablesBps === undefined ? {} : { overdueReceivablesBps }),
    missing, risks, ...evidence,
  };
}

export function calculateGrowth(lines: readonly GrowthLine[], asOf: string): GrowthResult {
  const asOfMs = asOfMilliseconds(asOf);
  if (!lines.length) {
    return {
      organizationId: 'UNKNOWN', status: 'unknown', currency: 'UNKNOWN',
      attribution: 'unknown', attributionAssumptions: [],
      missing: ['growth'], risks: ['增长未知：没有可用数据'],
      opportunities: [], stale: false, evidenceRefs: [], sources: [],
    };
  }
  const organizationId = requireText(lines[0]!.organizationId, 'organization_id');
  const currency = requireMoney(lines[0]!.currentRevenue).currency;
  let currentRevenue = 0n;
  let previousRevenue = 0n;
  let currentContribution = 0n;
  let previousContribution = 0n;
  let missingContribution = false;
  let missingAttribution = false;
  const attributionAssumptions = new Set<string>();
  for (const line of lines) {
    if (requireText(line.organizationId, 'organization_id') !== organizationId) {
      throw new Error('organization_mismatch');
    }
    requireText(line.channelId, 'channel_id');
    currentRevenue += requireMoney(line.currentRevenue, currency).minorUnits;
    previousRevenue += requireMoney(line.previousRevenue, currency).minorUnits;
    if (!line.currentContributionMargin || !line.previousContributionMargin) {
      missingContribution = true;
    } else {
      currentContribution += requireMoney(line.currentContributionMargin, currency).minorUnits;
      previousContribution += requireMoney(line.previousContributionMargin, currency).minorUnits;
    }
    if (!line.attributionAssumption?.trim()) missingAttribution = true;
    else attributionAssumptions.add(line.attributionAssumption.trim());
  }
  const revenueGrowthBps = ratioBps(currentRevenue, previousRevenue);
  const contributionGrowthBps = missingContribution
    ? undefined
    : ratioBps(currentContribution, previousContribution);
  const missing = [
    ...(revenueGrowthBps === undefined ? ['previous_revenue'] : []),
    ...(missingContribution || contributionGrowthBps === undefined ? ['contribution_margin'] : []),
    ...(missingAttribution ? ['attribution_assumption'] : []),
  ];
  const evidence = sourceEvidence(lines, asOfMs);
  const risks: string[] = [];
  const opportunities: string[] = [];
  if ((revenueGrowthBps ?? 0) > 0 && (contributionGrowthBps ?? 0) < 0) {
    risks.push('收入增长但贡献利润下降');
  } else if ((revenueGrowthBps ?? 0) > 0 && (contributionGrowthBps ?? 0) > 0) {
    opportunities.push('收入与贡献利润同步增长，可继续验证增量来源');
  }
  if (evidence.stale) risks.push('增长数据已过期');
  return {
    organizationId,
    status: missing.length ? 'partial' : 'known',
    currency,
    ...(revenueGrowthBps === undefined ? {} : { revenueGrowthBps }),
    ...(contributionGrowthBps === undefined ? {} : { contributionGrowthBps }),
    attribution: missingAttribution ? 'unknown' : 'hypothesis',
    attributionAssumptions: [...attributionAssumptions].sort(),
    missing: [...new Set(missing)], risks, opportunities, ...evidence,
  };
}
