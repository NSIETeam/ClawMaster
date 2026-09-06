/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import type { Action, CanonicalEvent, Money, ProfitLine } from './index.js';
import { calculateProfit } from './index.js';
import {
  calculateCashPosition,
  calculateGrowth,
  calculateInventory,
  type CashSnapshot,
  type GrowthLine,
  type InventoryLine,
} from './operatingEngines.js';
import { operatingFactKey, OPERATING_EVENT_TYPES } from './operatingFactIdentity.js';
export { OPERATING_EVENT_TYPES } from './operatingFactIdentity.js';

type SerializedMoney = { currency: string; minorUnits: string };
type MetricEvidence = {
  status: 'known' | 'partial' | 'unknown';
  stale: boolean;
  evidenceRefs: string[];
  sources: Array<{ source: string; sourceRevision: string; observedAt: string }>;
};

export interface OperatingBrief {
  organizationId: string;
  generatedAt: string;
  status: 'known' | 'partial' | 'unknown';
  metrics: {
    revenue: MetricEvidence & { amount: SerializedMoney | null };
    margin: MetricEvidence & { amount: SerializedMoney | null; basisPoints: number | null };
    inventory: MetricEvidence & { value: SerializedMoney | null; daysCover: number | null };
    cash: MetricEvidence & {
      balance: SerializedMoney | null;
      netWorkingCapital: SerializedMoney | null;
      runwayDays: number | null;
      overdueReceivablesBps: number | null;
    };
    growth: MetricEvidence & {
      revenueGrowthBps: number | null;
      contributionGrowthBps: number | null;
      attribution: 'observed' | 'hypothesis' | 'unknown';
      attributionAssumptions: string[];
    };
  };
  missing: string[];
  risks: string[];
  opportunities: string[];
  evidenceRefs: string[];
  invalidEvidenceRefs: string[];
  recommendedActions: Action[];
  executedActions: Action[];
  decisionsRequired: Action[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_operating_payload');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim();
}

function integer(value: unknown, field: string, optional = false): bigint | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 40 || !/^-?(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return BigInt(value);
}

function money(value: unknown, field: string, optional = false): Money | undefined {
  if (optional && value === undefined) return undefined;
  const input = object(value);
  return {
    currency: string(input.currency, `${field}_currency`)!,
    minorUnits: integer(input.minorUnits, `${field}_minor_units`)!,
  };
}

function freshness(event: CanonicalEvent) {
  return {
    organizationId: event.organizationId,
    observedAt: event.observedAt,
    source: event.source,
    sourceRevision: event.sourceRevision,
    ...(event.staleAfterMs === undefined ? {} : { staleAfterMs: event.staleAfterMs }),
    evidenceRefs: [event.id],
  };
}

function latestValidEvents(events: readonly CanonicalEvent[], asOfMs: number): {
  events: CanonicalEvent[];
  invalidEvidenceRefs: string[];
} {
  const latest = new Map<string, CanonicalEvent>();
  const invalidEvidenceRefs: string[] = [];
  for (const event of events) {
    if (!(OPERATING_EVENT_TYPES as readonly string[]).includes(event.type)) continue;
    try {
      const observedAtMs = Date.parse(event.observedAt);
      if (!Number.isFinite(observedAtMs) || observedAtMs > asOfMs) {
        throw new Error('invalid_observed_at');
      }
      const key = operatingFactKey(event);
      if (key === null) continue;
      const scopedKey = `${event.type}:${key}`;
      const current = latest.get(scopedKey);
      if (!current || observedAtMs >= Date.parse(current.observedAt)) {
        latest.set(scopedKey, event);
      }
    } catch {
      invalidEvidenceRefs.push(event.id);
    }
  }
  return { events: [...latest.values()], invalidEvidenceRefs: invalidEvidenceRefs.sort() };
}

function parseProfit(event: CanonicalEvent): ProfitLine {
  const payload = object(event.payload);
  return {
    ...freshness(event), skuId: string(payload.skuId, 'sku_id')!,
    channelId: string(payload.channelId, 'channel_id')!,
    storeId: string(payload.storeId, 'store_id', true),
    campaignId: string(payload.campaignId, 'campaign_id', true),
    revenue: money(payload.revenue, 'revenue')!, cost: money(payload.cost, 'cost', true),
    commission: money(payload.commission, 'commission', true),
    advertising: money(payload.advertising, 'advertising', true),
    fulfillment: money(payload.fulfillment, 'fulfillment', true),
    refunds: money(payload.refunds, 'refunds', true),
  };
}

function parseInventory(event: CanonicalEvent): InventoryLine {
  const payload = object(event.payload);
  return {
    ...freshness(event), skuId: string(payload.skuId, 'sku_id')!,
    warehouseId: string(payload.warehouseId, 'warehouse_id')!,
    onHandUnits: integer(payload.onHandUnits, 'on_hand_units')!,
    trailing28DayUnitsSold: integer(payload.trailing28DayUnitsSold, 'trailing_demand', true),
    unitCost: money(payload.unitCost, 'unit_cost', true),
  };
}

function parseCash(event: CanonicalEvent): CashSnapshot {
  const payload = object(event.payload);
  return {
    ...freshness(event), cash: money(payload.cash, 'cash')!,
    receivables: money(payload.receivables, 'receivables', true),
    overdueReceivables: money(payload.overdueReceivables, 'overdue_receivables', true),
    payables: money(payload.payables, 'payables', true),
    trailing30DayOperatingOutflow: money(
      payload.trailing30DayOperatingOutflow, 'operating_outflow', true,
    ),
  };
}

function parseGrowth(event: CanonicalEvent): GrowthLine {
  const payload = object(event.payload);
  return {
    ...freshness(event), channelId: string(payload.channelId, 'channel_id')!,
    skuId: string(payload.skuId, 'sku_id', true),
    campaignId: string(payload.campaignId, 'campaign_id', true),
    currentRevenue: money(payload.currentRevenue, 'current_revenue')!,
    previousRevenue: money(payload.previousRevenue, 'previous_revenue')!,
    currentContributionMargin: money(
      payload.currentContributionMargin, 'current_contribution_margin', true,
    ),
    previousContributionMargin: money(
      payload.previousContributionMargin, 'previous_contribution_margin', true,
    ),
    attributionAssumption: string(
      payload.attributionAssumption, 'attribution_assumption', true,
    ),
  };
}

function serialized(value: Money | undefined): SerializedMoney | null {
  return value ? { currency: value.currency, minorUnits: value.minorUnits.toString() } : null;
}

function eventEvidence(events: readonly CanonicalEvent[], asOfMs: number): MetricEvidence {
  const stale = events.some((event) => event.staleAfterMs !== undefined
    && Date.parse(event.observedAt) + event.staleAfterMs <= asOfMs);
  return {
    status: events.length ? 'known' : 'unknown', stale,
    evidenceRefs: events.map((event) => event.id).sort(),
    sources: events.map((event) => ({
      source: event.source, sourceRevision: event.sourceRevision, observedAt: event.observedAt,
    })).sort((left, right) => left.observedAt.localeCompare(right.observedAt)),
  };
}

export function buildOperatingBrief(input: {
  organizationId: string;
  events: readonly CanonicalEvent[];
  actions: readonly Action[];
  asOf: string;
}): OperatingBrief {
  for (const event of input.events) {
    if (event.organizationId !== input.organizationId) throw new Error('organization_mismatch');
  }
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) throw new Error('invalid_as_of');
  const selected = latestValidEvents(input.events, asOfMs);
  const byType = (type: string) => selected.events.filter((event) => event.type === type);
  const invalidEvidenceRefs = [...selected.invalidEvidenceRefs];
  const parseMany = <T>(events: CanonicalEvent[], parse: (event: CanonicalEvent) => T): T[] => {
    const output: T[] = [];
    for (const event of events) {
      try { output.push(parse(event)); } catch { invalidEvidenceRefs.push(event.id); }
    }
    return output;
  };
  const profitEvents = byType('companyos.profit.line.v1');
  const inventoryEvents = byType('companyos.inventory.line.v1');
  const cashEvents = byType('companyos.cash.snapshot.v1');
  const growthEvents = byType('companyos.growth.line.v1');
  const profitLines = parseMany(profitEvents, parseProfit);
  const inventoryLines = parseMany(inventoryEvents, parseInventory);
  const growthLines = parseMany(growthEvents, parseGrowth);
  const evaluate = <T>(
    events: readonly CanonicalEvent[],
    operation: () => T,
    fallback: () => T,
  ): T => {
    try {
      return operation();
    } catch {
      invalidEvidenceRefs.push(...events.map((event) => event.id));
      return fallback();
    }
  };
  const profit = evaluate(profitEvents, () => calculateProfit(profitLines), () => calculateProfit([]));
  const inventory = evaluate(
    inventoryEvents,
    () => calculateInventory(inventoryLines, input.asOf),
    () => calculateInventory([], input.asOf),
  );
  const cashInput = parseMany(cashEvents, parseCash)[0];
  const cash = cashInput ? evaluate(
    cashEvents,
    () => calculateCashPosition(cashInput, input.asOf),
    () => null,
  ) : null;
  const growth = evaluate(
    growthEvents,
    () => calculateGrowth(growthLines, input.asOf),
    () => calculateGrowth([], input.asOf),
  );
  const profitEvidence = eventEvidence(
    profitEvents.filter((event) => !invalidEvidenceRefs.includes(event.id)), asOfMs,
  );
  const revenueStatus = profitLines.length && profit.revenue.currency !== 'UNKNOWN'
    ? 'known' as const : 'unknown' as const;
  const missing = [
    ...(revenueStatus === 'unknown' ? ['profit'] : []),
    ...(inventory.status === 'unknown' ? ['inventory'] : []),
    ...(!cash ? ['cash'] : []),
    ...(growth.status === 'unknown' ? ['growth'] : []),
  ].sort();
  const anyStale = profitEvidence.stale || inventory.stale || Boolean(cash?.stale) || growth.stale;
  const uniqueInvalidEvidenceRefs = [...new Set(invalidEvidenceRefs)].sort();
  const risks = [
    ...(profit.status === 'unknown' ? ['利润未知：收入或成本事实不完整'] : []),
    ...inventory.risks,
    ...(cash?.risks ?? ['现金未知：没有可用数据']),
    ...growth.risks,
    ...(anyStale ? ['经营数据已过期，不能作为当前健康状态'] : []),
    ...(uniqueInvalidEvidenceRefs.length
      ? [`经营事实契约无效：${uniqueInvalidEvidenceRefs.length} 条事件未纳入计算`] : []),
  ];
  const metricStatuses = [
    revenueStatus, profit.status, inventory.status, cash?.status ?? 'unknown', growth.status,
  ];
  const status = metricStatuses.every((value) => value === 'known')
      && !uniqueInvalidEvidenceRefs.length && !anyStale
    ? 'known'
    : metricStatuses.every((value) => value === 'unknown') ? 'unknown' : 'partial';
  const orgActions = input.actions.filter((action) => action.organizationId === input.organizationId);
  const allEvidence = new Set([
    ...profitEvidence.evidenceRefs, ...inventory.evidenceRefs,
    ...(cash?.evidenceRefs ?? []), ...growth.evidenceRefs,
  ]);
  return {
    organizationId: input.organizationId, generatedAt: input.asOf, status,
    metrics: {
      revenue: {
        ...profitEvidence, status: revenueStatus,
        amount: serialized(revenueStatus === 'known' ? profit.revenue : undefined),
      },
      margin: {
        ...profitEvidence, status: profit.status, amount: serialized(profit.contributionMargin),
        basisPoints: profit.marginBps ?? null,
      },
      inventory: {
        status: inventory.status, stale: inventory.stale,
        evidenceRefs: inventory.evidenceRefs, sources: inventory.sources,
        value: serialized(inventory.inventoryValue), daysCover: inventory.daysCover ?? null,
      },
      cash: cash ? {
        status: cash.status, stale: cash.stale, evidenceRefs: cash.evidenceRefs,
        sources: cash.sources, balance: serialized(cash.cash),
        netWorkingCapital: serialized(cash.netWorkingCapital),
        runwayDays: cash.runwayDays ?? null,
        overdueReceivablesBps: cash.overdueReceivablesBps ?? null,
      } : {
        status: 'unknown', stale: false, evidenceRefs: [], sources: [], balance: null,
        netWorkingCapital: null, runwayDays: null, overdueReceivablesBps: null,
      },
      growth: {
        status: growth.status, stale: growth.stale, evidenceRefs: growth.evidenceRefs,
        sources: growth.sources, revenueGrowthBps: growth.revenueGrowthBps ?? null,
        contributionGrowthBps: growth.contributionGrowthBps ?? null,
        attribution: growth.attribution,
        attributionAssumptions: growth.attributionAssumptions,
      },
    },
    missing, risks, opportunities: growth.opportunities,
    evidenceRefs: [...allEvidence].sort(), invalidEvidenceRefs: uniqueInvalidEvidenceRefs,
    recommendedActions: orgActions.filter((action) => action.status === 'recommended'),
    executedActions: orgActions.filter((action) => action.status === 'executed'),
    decisionsRequired: orgActions.filter((action) => action.status === 'queued'),
  };
}
