import { describe, expect, it, vi } from 'vitest';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from '../data_platform/index.js';
import { createCanonicalEvent } from './index.js';
import { createPostgresCompanyOsRepository } from './postgresCompanyOsRepository.js';

function result<Row extends Record<string, unknown>>(rows: Row[]): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length };
}

const event = createCanonicalEvent({
  organizationId: 'org-1',
  type: 'owl.price.anomaly',
  payload: { skuId: 'sku-1' },
  source: 'owl',
  sourceRevision: 'r1',
  observedAt: '2026-09-06T02:00:00.000Z',
  correlationId: 'correlation-1',
  idempotencyKey: 'price-1',
});

describe('PostgreSQL CompanyOS authority', () => {
  it('lists only projected operating facts for one tenant', async () => {
    const query = vi.fn().mockResolvedValueOnce(result([{
      cursor: 1, organization_id: event.organizationId, event_id: event.id,
      event_type: event.type, payload: event.payload, source: event.source,
      source_revision: event.sourceRevision, observed_at: event.observedAt,
      correlation_id: event.correlationId, causation_id: null,
      idempotency_key: event.idempotencyKey,
    }]));
    const repository = createPostgresCompanyOsRepository({
      pool: { query } as unknown as PostgresPoolLike,
    });
    await expect(repository.listLatestCompanyOsFacts('org-1', ['owl.price.anomaly']))
      .resolves.toEqual([event]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM companyos_latest_facts latest'),
      ['org-1', ['owl.price.anomaly']],
    );
  });

  it('returns the canonical event inserted into PostgreSQL', async () => {
    const query = vi.fn().mockResolvedValueOnce(result([{
      cursor: 1, organization_id: event.organizationId, event_id: event.id,
      event_type: event.type, payload: event.payload, source: event.source,
      source_revision: event.sourceRevision, observed_at: event.observedAt,
      correlation_id: event.correlationId, causation_id: null,
      idempotency_key: event.idempotencyKey, fact_fingerprint: 'a'.repeat(64),
    }]));
    const repository = createPostgresCompanyOsRepository({
      pool: { query } as unknown as PostgresPoolLike,
    });
    await expect(repository.publishCompanyOsEvent(event)).resolves.toEqual(event);
    expect(query.mock.calls[0]![0]).toContain('INSERT INTO companyos_latest_facts');
  });

  it('atomically projects an operating event by its stable business identity', async () => {
    const operating = createCanonicalEvent({
      organizationId: 'org-1', type: 'companyos.profit.line.v1',
      payload: { skuId: 'sku:1', channelId: 'online', storeId: 'flagship' },
      source: 'erp', sourceRevision: 'r2', observedAt: '2026-09-06T03:00:00.000Z',
      correlationId: 'correlation-2', idempotencyKey: 'profit-1',
    });
    const query = vi.fn().mockResolvedValueOnce(result([{
      cursor: 2, organization_id: operating.organizationId, event_id: operating.id,
      event_type: operating.type, payload: operating.payload, source: operating.source,
      source_revision: operating.sourceRevision, observed_at: operating.observedAt,
      correlation_id: operating.correlationId, causation_id: null,
      idempotency_key: operating.idempotencyKey, fact_fingerprint: 'a'.repeat(64),
    }]));
    const repository = createPostgresCompanyOsRepository({
      pool: { query } as unknown as PostgresPoolLike,
    });
    await expect(repository.publishCompanyOsEvent(operating)).resolves.toEqual(operating);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toContain('WITH inserted AS');
    expect(query.mock.calls[0]![0]).toContain('EXCLUDED.observed_at >');
    expect(query.mock.calls[0]![1]![11]).toBe('5:sku:1|6:online|8:flagship');
  });

  it('publishes canonical events with tenant idempotency and detects conflicts', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{
        cursor: 1, organization_id: event.organizationId, event_id: event.id,
        event_type: event.type, payload: event.payload, source: event.source,
        source_revision: event.sourceRevision, observed_at: event.observedAt,
        correlation_id: event.correlationId, causation_id: null,
        idempotency_key: event.idempotencyKey, fact_fingerprint: '0'.repeat(64),
      }]));
    const pool = { query } as unknown as PostgresPoolLike;
    const repository = createPostgresCompanyOsRepository({ pool });

    await expect(repository.publishCompanyOsEvent(event)).rejects
      .toThrow('idempotency_conflict');
    expect(query.mock.calls[0]![0]).toContain('ON CONFLICT (organization_id, idempotency_key) DO NOTHING');
    expect(query.mock.calls[1]![0]).toContain('WHERE organization_id = $1 AND idempotency_key = $2');
  });

  it('claims one expired or unowned event with row locking and a fencing token', async () => {
    const query = vi.fn().mockResolvedValueOnce(result([{
      cursor: 9, organization_id: event.organizationId, event_id: event.id,
      event_type: event.type, payload: event.payload, source: event.source,
      source_revision: event.sourceRevision, observed_at: event.observedAt,
      correlation_id: event.correlationId, causation_id: null,
      idempotency_key: event.idempotencyKey, fence_token: 4,
      lease_expires_at: '2026-09-06T02:01:00.000Z',
    }]));
    const pool = { query } as unknown as PostgresPoolLike;
    const repository = createPostgresCompanyOsRepository({
      pool, now: () => new Date('2026-09-06T02:00:00.000Z'),
    });

    await expect(repository.claimNextCompanyOsEvent({
      organizationId: 'org-1', consumerId: 'brand-watchdog-v1',
      workerId: 'worker-1', leaseDurationMs: 60_000,
    })).resolves.toMatchObject({ eventCursor: 9, fenceToken: 4, ownerId: 'worker-1' });
    expect(query.mock.calls[0]![0]).toContain('FOR UPDATE OF event SKIP LOCKED');
    expect(query.mock.calls[0]![0]).toContain('companyos_event_claims.fence_token + 1');
  });

  it('fences and atomically persists Watchdog projections before acknowledging', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT event.cursor')) return result([{
        cursor: 9, organization_id: event.organizationId, event_id: event.id,
        event_type: event.type, payload: event.payload, source: event.source,
        source_revision: event.sourceRevision, observed_at: event.observedAt,
        correlation_id: event.correlationId, causation_id: null,
        idempotency_key: event.idempotencyKey,
      }]);
      if (sql.includes('DELETE FROM companyos_event_claims')) {
        return { rows: [], rowCount: 1 };
      }
      return result([]);
    });
    const client = { query, release: vi.fn() } as unknown as PostgresClientLike;
    const pool = { connect: vi.fn(async () => client) } as unknown as PostgresPoolLike;
    const repository = createPostgresCompanyOsRepository({
      pool, now: () => new Date('2026-09-06T02:00:30.000Z'),
    });

    await repository.completeCompanyOsWatchdogClaim({
      consumerId: 'brand-watchdog-v1', eventCursor: 9,
      organizationId: 'org-1', ownerId: 'worker-1', fenceToken: 4,
      leaseExpiresAt: '2026-09-06T02:01:00.000Z', event,
    });
    const sql = query.mock.calls.map((call) => call[0]).join('\n');
    expect(sql).toContain('claim.fence_token = $5');
    expect(sql).toContain('claim.lease_expires_at > $6::timestamptz');
    expect(sql).toContain('INSERT INTO companyos_actions');
    expect(sql).toContain('INSERT INTO companyos_tasks');
    expect(sql).toContain('INSERT INTO companyos_audit');
    expect(sql).toContain('INSERT INTO companyos_event_receipts');
    expect(query.mock.calls.at(-1)![0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back without projections when the fencing claim is no longer current', async () => {
    const query = vi.fn(async () => result([]));
    const client = { query, release: vi.fn() } as unknown as PostgresClientLike;
    const pool = { connect: vi.fn(async () => client) } as unknown as PostgresPoolLike;
    const repository = createPostgresCompanyOsRepository({ pool });

    await expect(repository.completeCompanyOsWatchdogClaim({
      consumerId: 'brand-watchdog-v1', eventCursor: 9,
      organizationId: 'org-1', ownerId: 'worker-stale', fenceToken: 3,
      leaseExpiresAt: '2026-09-06T02:01:00.000Z', event,
    })).rejects.toThrow('consumer_lease_lost');
    const sql = query.mock.calls.map((call) => call[0]).join('\n');
    expect(sql).not.toContain('INSERT INTO companyos_actions');
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('acknowledges a non-actionable fact without creating projections', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT event.cursor')) return result([{
        cursor: 10, organization_id: event.organizationId, event_id: 'inventory-1',
        event_type: 'inventory.snapshot', payload: {}, source: event.source,
        source_revision: event.sourceRevision, observed_at: event.observedAt,
        correlation_id: event.correlationId, causation_id: null,
        idempotency_key: 'inventory-1',
      }]);
      if (sql.includes('DELETE FROM companyos_event_claims')) {
        return { rows: [], rowCount: 1 };
      }
      return result([]);
    });
    const client = { query, release: vi.fn() } as unknown as PostgresClientLike;
    const repository = createPostgresCompanyOsRepository({
      pool: { connect: vi.fn(async () => client) } as unknown as PostgresPoolLike,
    });
    await repository.completeCompanyOsWatchdogClaim({
      consumerId: 'brand-watchdog-v1', eventCursor: 10,
      organizationId: 'org-1', ownerId: 'worker-1', fenceToken: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      event: { ...event, id: 'inventory-1', type: 'inventory.snapshot' },
    });
    const sql = query.mock.calls.map((call) => call[0]).join('\n');
    expect(sql).toContain('INSERT INTO companyos_event_receipts');
    expect(sql).not.toContain('INSERT INTO companyos_actions');
    expect(sql).not.toContain('INSERT INTO companyos_tasks');
    expect(sql).not.toContain('INSERT INTO companyos_audit');
  });

  it('atomically approves a task into the action queue with human audit', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM companyos_tasks') && sql.includes('FOR UPDATE')) {
        return result([{
          task_id: 'task-1', organization_id: 'org-1', action_id: 'action-1',
          title: '人工决策', status: 'pending_decision', evidence_event_ids: ['event-1'],
        }]);
      }
      if (sql.startsWith('UPDATE companyos_tasks')) return { rows: [], rowCount: 1 };
      return result([]);
    });
    const client = { query, release: vi.fn() } as unknown as PostgresClientLike;
    const repository = createPostgresCompanyOsRepository({
      pool: { connect: vi.fn(async () => client) } as unknown as PostgresPoolLike,
      now: () => new Date('2026-09-06T03:00:00.000Z'),
    });
    await expect(repository.decideCompanyOsTask({
      organizationId: 'org-1', taskId: 'task-1', decision: 'approve',
    })).resolves.toMatchObject({ id: 'task-1', status: 'approved' });
    const sql = query.mock.calls.map((call) => call[0]).join('\n');
    const actionUpdate = query.mock.calls.find((call) => (
      call[0].includes('UPDATE companyos_actions')
    ));
    expect(actionUpdate?.[1]).toEqual([
      'org-1', 'action-1', 'queued', '2026-09-06T03:00:00.000Z',
    ]);
    expect(sql).toContain('INSERT INTO companyos_audit');
    expect(sql).toContain("'human'");
    expect(query.mock.calls.at(-1)![0]).toBe('COMMIT');
  });
});
