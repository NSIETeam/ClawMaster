/**
 * Brand AI COO vertical slice.
 *
 * This module owns brand-domain semantics outside the runtime kernel. It is
 * intentionally provider-neutral so 金蝶/用友/聚水潭/钉钉/企业微信/Excel
 * adapters can project into the same contracts without becoming new SaaS apps.
 */

export type CanonicalEntity =
  | 'Organization' | 'People' | 'Brand' | 'Product' | 'SKU' | 'Channel' | 'Store'
  | 'Distributor' | 'Customer' | 'Supplier' | 'Order' | 'Contract' | 'Inventory'
  | 'Warehouse' | 'Campaign' | 'AdSpend' | 'Revenue' | 'Cost' | 'Margin' | 'Cash'
  | 'Task' | 'Document' | 'Conversation' | 'Event';

export type Money = { currency: string; minorUnits: bigint };
export type DataFreshness = { observedAt: string; source: string; sourceRevision: string; staleAfterMs?: number };

export type ProfitLine = DataFreshness & {
  organizationId: string;
  skuId: string;
  channelId: string;
  storeId?: string;
  campaignId?: string;
  revenue: Money;
  cost?: Money;
  commission?: Money;
  advertising?: Money;
  fulfillment?: Money;
  refunds?: Money;
};

export type ProfitResult = {
  currency: string;
  revenue: Money;
  totalCost?: Money;
  contributionMargin?: Money;
  marginBps?: number;
  status: 'known' | 'unknown';
  missing: string[];
  bySku: Record<string, { revenue: Money; contributionMargin?: Money; marginBps?: number; status: 'known' | 'unknown' }>;
};

export type CanonicalEvent = DataFreshness & {
  id: string;
  organizationId: string;
  type: string;
  payload: unknown;
  correlationId: string;
  causationId?: string;
  idempotencyKey: string;
};

export type AuditEntry = {
  id: string;
  organizationId: string;
  action: string;
  status: 'recommended' | 'executed' | 'failed' | 'unknown_outcome';
  actor: 'brand-ceo-agent' | 'human';
  evidenceEventIds: string[];
  at: string;
};

export type Action = {
  id: string;
  organizationId: string;
  title: string;
  reason: string;
  status: 'recommended' | 'queued' | 'executed' | 'failed' | 'unknown_outcome';
  evidenceEventIds: string[];
};

function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error('currency_mismatch');
  return { currency: a.currency, minorUnits: a.minorUnits + b.minorUnits };
}

function zero(currency: string): Money { return { currency, minorUnits: 0n }; }

function subtract(base: Money, ...values: Array<Money | undefined>): Money {
  let result = base;
  for (const value of values) if (value) result = add(result, { currency: value.currency, minorUnits: -value.minorUnits });
  return result;
}

export function calculateProfit(lines: readonly ProfitLine[]): ProfitResult {
  if (!lines.length) return { currency: 'UNKNOWN', revenue: zero('UNKNOWN'), status: 'unknown', missing: ['revenue'], bySku: {} };
  const currency = lines[0].revenue.currency;
  let revenue = zero(currency);
  let totalCost = zero(currency);
  let hasMissingCost = false;
  const bySku: ProfitResult['bySku'] = {};
  for (const line of lines) {
    revenue = add(revenue, line.revenue);
    const knownCost = Boolean(line.cost && line.commission && line.advertising && line.fulfillment);
    const contribution = knownCost ? subtract(line.revenue, line.cost!, line.commission!, line.advertising!, line.fulfillment!, line.refunds) : undefined;
    if (!knownCost) hasMissingCost = true;
    else {
      const lineCost = add(add(add(line.cost!, line.commission!), line.advertising!), line.fulfillment!);
      totalCost = add(totalCost, line.refunds ? add(lineCost, line.refunds) : lineCost);
    }
    const current = bySku[line.skuId] ?? { revenue: zero(currency), status: 'known' as const };
    current.revenue = add(current.revenue, line.revenue);
    if (contribution) current.contributionMargin = add(current.contributionMargin ?? zero(currency), contribution);
    current.status = current.status === 'unknown' || !knownCost ? 'unknown' : 'known';
    if (current.contributionMargin && current.revenue.minorUnits !== 0n) current.marginBps = Number(current.contributionMargin.minorUnits * 10000n / current.revenue.minorUnits);
    bySku[line.skuId] = current;
  }
  const contributionMargin = hasMissingCost ? undefined : subtract(revenue, totalCost);
  return {
    currency, revenue, totalCost: hasMissingCost ? undefined : totalCost, contributionMargin,
    marginBps: contributionMargin && revenue.minorUnits !== 0n ? Number(contributionMargin.minorUnits * 10000n / revenue.minorUnits) : undefined,
    status: hasMissingCost ? 'unknown' : 'known', missing: hasMissingCost ? ['cost'] : [], bySku,
  };
}

export class InMemoryEventBus {
  readonly events: CanonicalEvent[] = [];
  private readonly consumed = new Map<string, Set<string>>();

  publish(event: CanonicalEvent): CanonicalEvent {
    if (!this.events.some((item) => item.organizationId === event.organizationId && item.idempotencyKey === event.idempotencyKey)) this.events.push(event);
    return this.events.find((item) => item.organizationId === event.organizationId && item.idempotencyKey === event.idempotencyKey)!;
  }

  consume(consumer: string, handler: (event: CanonicalEvent) => void): number {
    const seen = this.consumed.get(consumer) ?? new Set<string>();
    let count = 0;
    for (const event of this.events) if (!seen.has(event.id)) { handler(event); seen.add(event.id); count++; }
    this.consumed.set(consumer, seen);
    return count;
  }
}

export class BrandWatchdog {
  readonly actions: Action[] = [];
  readonly audit: AuditEntry[] = [];
  constructor(private readonly bus: InMemoryEventBus, private readonly now = () => new Date().toISOString()) {}

  inspect(): number {
    return this.bus.consume('brand-watchdog', (event) => {
      const actionable = ['owl.price.anomaly', 'zhilemon.gmv.anomaly', 'zhilemon.refund.anomaly'].includes(event.type);
      if (!actionable) return;
      const action: Action = { id: `action-${this.actions.length + 1}`, organizationId: event.organizationId, title: `调查${event.type}`, reason: '平台事件显示经营异常，需调查后再执行副作用动作', status: 'recommended', evidenceEventIds: [event.id] };
      this.actions.push(action);
      this.audit.push({ id: `audit-${this.audit.length + 1}`, organizationId: event.organizationId, action: 'watchdog.recommendation.created', status: 'recommended', actor: 'brand-ceo-agent', evidenceEventIds: [event.id], at: this.now() });
    });
  }
}

export type CeoBrief = {
  organizationId: string;
  metrics: { revenue: Money; margin: Money | null; marginStatus: ProfitResult['status'] };
  risks: string[];
  opportunities: string[];
  recommendedActions: Action[];
  executedActions: Action[];
  decisionsRequired: Action[];
};

export function buildCeoBrief(organizationId: string, profit: ProfitResult, actions: readonly Action[]): CeoBrief {
  const orgActions = actions.filter((action) => action.organizationId === organizationId);
  return {
    organizationId,
    metrics: { revenue: profit.revenue, margin: profit.contributionMargin ?? null, marginStatus: profit.status },
    risks: profit.status === 'unknown' ? ['利润未知：成本数据缺失，不能判断是否盈利'] : profit.marginBps !== undefined && profit.marginBps < 2000 ? ['贡献利润低于20%盈亏警戒线'] : [],
    opportunities: profit.status === 'known' && (profit.marginBps ?? 0) >= 3000 ? ['存在可继续验证的高贡献利润增长空间'] : [],
    recommendedActions: orgActions.filter((action) => action.status === 'recommended'),
    executedActions: orgActions.filter((action) => action.status === 'executed'),
    decisionsRequired: orgActions.filter((action) => action.status === 'queued'),
  };
}

export function createCanonicalEvent(input: Omit<CanonicalEvent, 'id'> & { id?: string }): CanonicalEvent {
  return { ...input, id: input.id ?? `${input.organizationId}:${input.idempotencyKey}` };
}
