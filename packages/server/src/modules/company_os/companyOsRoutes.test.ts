import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../data_platform/index.js';
import { COMPANY_OS_SCHEMA_CONTRIBUTOR } from './companyOsSchema.js';
import { handleCompanyOsRoute } from './companyOsRoutes.js';

const databases: Database[] = [];

function harness(input: {
  path: string;
  method: string;
  body?: Record<string, unknown>;
  memberOrganizationId?: string;
  adminOrganizationId?: string;
  connectorReadiness?: unknown[];
  actionConnector?: {
    provider: string;
    execute: ReturnType<typeof vi.fn>;
    reconcile?: ReturnType<typeof vi.fn>;
  };
  authorizeActionExecution?: boolean;
}) {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys = ON; CREATE TABLE organizations (id TEXT PRIMARY KEY);');
  COMPANY_OS_SCHEMA_CONTRIBUTOR.apply(database);
  database.prepare('INSERT INTO organizations (id) VALUES (?), (?)').run('org-1', 'org-2');
  const responses: Array<{ status: number; data: unknown }> = [];
  const deps = {
    path: input.path,
    method: input.method,
    req: {} as never,
    res: {} as never,
    memberAccount: input.memberOrganizationId ? {
      id: 'member-1', organizationId: input.memberOrganizationId,
    } as never : null,
    adminPrincipal: input.adminOrganizationId ? {
      kind: 'system' as const, organizationId: input.adminOrganizationId,
    } : null,
    store: { db: () => database, now: () => Date.parse('2026-09-06T02:00:00.000Z') },
    readBody: async () => input.body ?? {},
    sendJSON: (_res: never, status: number, data: unknown) => responses.push({ status, data }),
    listConnectorReadiness: vi.fn(async () => input.connectorReadiness ?? []),
    resolveActionConnector: (provider: string) => (
      input.actionConnector?.provider === provider ? input.actionConnector : undefined
    ),
    authorizeActionExecution: () => input.authorizeActionExecution ?? false,
  };
  return { deps, responses, database };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('CompanyOS authenticated routes', () => {
  it('fails closed when no approved action connector is installed', async () => {
    const { deps, responses } = harness({
      path: '/enterprise/companyos/actions/action-1/execute', method: 'POST',
      adminOrganizationId: 'org-1', body: { provider: 'owl' },
    });
    await handleCompanyOsRoute(deps);
    expect(responses).toEqual([{ status: 503, data: { error: 'action_connector_unavailable' } }]);
  });

  it('executes an approved action through the injected connector with a durable receipt', async () => {
    const connector = {
      provider: 'owl',
      execute: vi.fn(async () => ({
        outcome: 'committed' as const, receiptId: 'receipt-1', summary: 'accepted',
      })),
    };
    const { deps, responses, database } = harness({
      path: '/enterprise/companyos/actions/action-1/execute', method: 'POST',
      adminOrganizationId: 'org-1', body: { provider: 'owl' },
      actionConnector: connector, authorizeActionExecution: true,
    });
    database.prepare(
      `INSERT INTO companyos_actions
        (action_id, organization_id, source_event_id, title, reason, status,
         evidence_event_ids_json, created_at_ms, updated_at_ms)
       VALUES ('action-1', 'org-1', 'event-1', '核查价格', '价格异常', 'queued',
               '["event-1"]', 1, 1)`,
    ).run();
    database.prepare(
      `INSERT INTO companyos_tasks
        (task_id, organization_id, action_id, title, status,
         evidence_event_ids_json, created_at_ms, updated_at_ms)
       VALUES ('task-1', 'org-1', 'action-1', '审批', 'approved', '["event-1"]', 1, 1)`,
    ).run();
    await handleCompanyOsRoute(deps);
    expect(responses).toEqual([{ status: 200, data: { execution: expect.objectContaining({
      status: 'executed', providerReceiptId: 'receipt-1',
    }) } }]);
    expect(connector.execute).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'companyos:org-1:action-1',
    }));
  });
  it('rejects event ingestion without an administrator principal', async () => {
    const { deps, responses } = harness({
      path: '/enterprise/companyos/events', method: 'POST', memberOrganizationId: 'org-1',
    });
    expect(await handleCompanyOsRoute(deps)).toBe(true);
    expect(responses).toEqual([{ status: 403, data: { error: 'CompanyOS 管理员权限不足' } }]);
  });

  it('takes the tenant from the principal rather than the request body', async () => {
    const { deps, responses, database } = harness({
      path: '/enterprise/companyos/events', method: 'POST', adminOrganizationId: 'org-1',
      body: {
        organizationId: 'org-2', type: 'owl.price.anomaly', payload: { skuId: 'sku-1' },
        source: 'owl', sourceRevision: 'r1', observedAt: '2026-09-06T01:59:00.000Z',
        correlationId: 'correlation-1', idempotencyKey: 'price-1',
      },
    });
    expect(await handleCompanyOsRoute(deps)).toBe(true);
    expect(responses[0]).toMatchObject({ status: 201, data: { event: { organizationId: 'org-1' } } });
    expect(database.prepare('SELECT organization_id FROM companyos_events').get())
      .toEqual({ organization_id: 'org-1' });
  });

  it('runs the watchdog idempotently and persists its action', async () => {
    const published = harness({
      path: '/enterprise/companyos/events', method: 'POST', adminOrganizationId: 'org-1',
      body: {
        type: 'zhilemon.refund.anomaly', payload: { deltaBps: 900 }, source: 'zhilemon',
        sourceRevision: 'r2', observedAt: '2026-09-06T01:58:00.000Z',
        correlationId: 'correlation-2', idempotencyKey: 'refund-1',
      },
    });
    await handleCompanyOsRoute(published.deps);
    const inspectDeps = {
      ...published.deps,
      path: '/enterprise/companyos/watchdog/inspect',
      body: undefined,
    };
    await handleCompanyOsRoute(inspectDeps);
    await handleCompanyOsRoute(inspectDeps);
    expect(published.database.prepare('SELECT COUNT(*) AS count FROM companyos_actions').get())
      .toEqual({ count: 1 });
    expect(published.database.prepare('SELECT COUNT(*) AS count FROM companyos_audit').get())
      .toEqual({ count: 1 });
  });

  it('does not process another tenant when an administrator runs the watchdog', async () => {
    const { deps, responses, database } = harness({
      path: '/enterprise/companyos/watchdog/inspect', method: 'POST',
      adminOrganizationId: 'org-1',
    });
    database.prepare(
      `INSERT INTO companyos_events
        (organization_id, event_id, event_type, payload_json, source,
         source_revision, observed_at, correlation_id, causation_id,
         idempotency_key, fact_fingerprint, created_at_ms)
       VALUES ('org-2', 'event-2', 'owl.price.anomaly', '{}', 'owl', 'r1',
               '2026-09-06T01:59:00.000Z', 'correlation-2', NULL,
               'price-2', 'fingerprint-2', 1)`,
    ).run();
    expect(await handleCompanyOsRoute(deps)).toBe(true);
    expect(responses).toEqual([{ status: 200, data: { processed: 0 } }]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM companyos_actions').get())
      .toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM companyos_event_receipts').get())
      .toEqual({ count: 0 });
  });

  it('lists only actions owned by the member tenant', async () => {
    const { deps, responses, database } = harness({
      path: '/enterprise/companyos/actions', method: 'GET', memberOrganizationId: 'org-1',
    });
    database.exec(`
      INSERT INTO companyos_actions
        (action_id, organization_id, source_event_id, title, reason, status,
         evidence_event_ids_json, created_at_ms, updated_at_ms)
      VALUES
        ('a1', 'org-1', 'e1', '本组织', 'reason', 'recommended', '[]', 1, 1),
        ('a2', 'org-2', 'e2', '其他组织', 'reason', 'recommended', '[]', 1, 1);
    `);
    expect(await handleCompanyOsRoute(deps)).toBe(true);
    expect(responses).toEqual([{
      status: 200,
      data: { actions: [expect.objectContaining({ id: 'a1', organizationId: 'org-1' })] },
    }]);
  });

  it('lists only decision tasks owned by the member tenant', async () => {
    const { deps, responses, database } = harness({
      path: '/enterprise/companyos/tasks', method: 'GET', memberOrganizationId: 'org-1',
    });
    database.exec(`
      INSERT INTO companyos_actions
        (action_id, organization_id, source_event_id, title, reason, status,
         evidence_event_ids_json, created_at_ms, updated_at_ms)
      VALUES
        ('a1', 'org-1', 'e1', '本组织', 'reason', 'recommended', '[]', 1, 1),
        ('a2', 'org-2', 'e2', '其他组织', 'reason', 'recommended', '[]', 1, 1);
      INSERT INTO companyos_tasks
        (task_id, organization_id, action_id, title, status,
         evidence_event_ids_json, created_at_ms, updated_at_ms)
      VALUES
        ('t1', 'org-1', 'a1', '本组织任务', 'pending_decision', '[]', 1, 1),
        ('t2', 'org-2', 'a2', '其他组织任务', 'pending_decision', '[]', 1, 1);
    `);
    expect(await handleCompanyOsRoute(deps)).toBe(true);
    expect(responses).toEqual([{
      status: 200,
      data: { tasks: [expect.objectContaining({ id: 't1', organizationId: 'org-1' })] },
    }]);
  });

  it('requires an administrator to explicitly approve a decision task', async () => {
    const member = harness({
      path: '/enterprise/companyos/tasks/t1/decision', method: 'POST',
      memberOrganizationId: 'org-1', body: { decision: 'approve' },
    });
    expect(await handleCompanyOsRoute(member.deps)).toBe(true);
    expect(member.responses).toEqual([{
      status: 403, data: { error: 'CompanyOS 管理员权限不足' },
    }]);

    const admin = harness({
      path: '/enterprise/companyos/tasks/t1/decision', method: 'POST',
      adminOrganizationId: 'org-1', body: { decision: 'approve' },
    });
    admin.database.exec(`
      INSERT INTO companyos_actions
        (action_id, organization_id, source_event_id, title, reason, status,
         evidence_event_ids_json, created_at_ms, updated_at_ms)
      VALUES ('a1', 'org-1', 'e1', '调查异常', 'reason', 'recommended', '["e1"]', 1, 1);
      INSERT INTO companyos_tasks
        (task_id, organization_id, action_id, title, status,
         evidence_event_ids_json, created_at_ms, updated_at_ms)
      VALUES ('t1', 'org-1', 'a1', '人工决策', 'pending_decision', '["e1"]', 1, 1);
    `);
    expect(await handleCompanyOsRoute(admin.deps)).toBe(true);
    expect(admin.responses).toEqual([{
      status: 200, data: { task: expect.objectContaining({ id: 't1', status: 'approved' }) },
    }]);
  });

  it('shows connector readiness only for the signed-in tenant', async () => {
    const { deps, responses } = harness({
      path: '/enterprise/companyos/connectors', method: 'GET',
      memberOrganizationId: 'org-1',
      connectorReadiness: [{ connectorId: 'owl-pricing-v1', state: 'blocked' }],
    });
    expect(await handleCompanyOsRoute(deps)).toBe(true);
    expect(deps.listConnectorReadiness).toHaveBeenCalledWith('org-1');
    expect(responses).toEqual([{
      status: 200,
      data: { connectors: [{ connectorId: 'owl-pricing-v1', state: 'blocked' }] },
    }]);
  });

  it('builds a tenant-scoped JSON-safe operating brief from durable events', async () => {
    const { deps, responses } = harness({
      path: '/enterprise/companyos/events', method: 'POST', adminOrganizationId: 'org-1',
      body: {
        type: 'companyos.cash.snapshot.v1',
        payload: {
          cash: { currency: 'CNY', minorUnits: '3000000' },
          receivables: { currency: 'CNY', minorUnits: '1000000' },
          overdueReceivables: { currency: 'CNY', minorUnits: '400000' },
          payables: { currency: 'CNY', minorUnits: '800000' },
          trailing30DayOperatingOutflow: { currency: 'CNY', minorUnits: '1500000' },
        },
        source: 'finance-test', sourceRevision: 'r1',
        observedAt: '2026-09-06T01:59:00.000Z', correlationId: 'cash-1',
        idempotencyKey: 'cash-1',
      },
    });
    await handleCompanyOsRoute(deps);
    responses.length = 0;
    expect(await handleCompanyOsRoute({
      ...deps, path: '/enterprise/companyos/brief', method: 'GET',
      memberAccount: { id: 'member-1', organizationId: 'org-1' } as never,
      adminPrincipal: null,
    })).toBe(true);
    expect(responses).toEqual([{
      status: 200,
      data: { brief: expect.objectContaining({
        organizationId: 'org-1', status: 'partial',
        metrics: expect.objectContaining({
          cash: expect.objectContaining({
            balance: { currency: 'CNY', minorUnits: '3000000' }, runwayDays: 60,
          }),
        }),
      }) },
    }]);
    expect(() => JSON.stringify(responses[0]!.data)).not.toThrow();
  });
});
