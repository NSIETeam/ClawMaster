/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  PostgresClientLike,
  PostgresPoolLike,
} from '../data_platform/index.js';
import type {
  Action,
  AuditEntry,
  CanonicalEvent,
  CompanyOsTask,
} from './index.js';

interface EventRow extends Record<string, unknown> {
  cursor: number | string;
  organization_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  source: string;
  source_revision: string;
  observed_at: Date | string;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string;
  fact_fingerprint?: string;
}

interface ClaimRow extends EventRow {
  fence_token: number | string;
  lease_expires_at: Date | string;
}

export interface PostgresCompanyOsEventClaim {
  consumerId: string;
  eventCursor: number;
  organizationId: string;
  ownerId: string;
  fenceToken: number;
  leaseExpiresAt: string;
  event: CanonicalEvent;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw new Error(`invalid_${field}`);
  return normalized;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_event_payload');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(',')}]`;
  if (typeof value !== 'object' || seen.has(value)) throw new Error('invalid_event_payload');
  seen.add(value);
  const object = value as Record<string, unknown>;
  const encoded = `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(object[key], seen)}`
  )).join(',')}}`;
  seen.delete(value);
  return encoded;
}

function fingerprint(event: CanonicalEvent, payloadJson: string): string {
  return createHash('sha256').update(stableJson({
    type: event.type,
    payload: JSON.parse(payloadJson) as unknown,
    source: event.source,
    sourceRevision: event.sourceRevision,
    observedAt: event.observedAt,
    correlationId: event.correlationId,
    causationId: event.causationId ?? null,
  })).digest('hex');
}

function eventFromRow(row: EventRow): CanonicalEvent {
  return {
    id: row.event_id,
    organizationId: row.organization_id,
    type: row.event_type,
    payload: json(row.payload),
    source: row.source,
    sourceRevision: row.source_revision,
    observedAt: iso(row.observed_at),
    correlationId: row.correlation_id,
    causationId: row.causation_id ?? undefined,
    idempotencyKey: row.idempotency_key,
  };
}

async function transaction<T>(
  pool: PostgresPoolLike,
  operation: (client: PostgresClientLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let active = false;
  try {
    await client.query('BEGIN');
    active = true;
    const result = await operation(client);
    await client.query('COMMIT');
    active = false;
    return result;
  } catch (error) {
    if (active) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the CompanyOS or PostgreSQL error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresCompanyOsRepository(input: {
  pool: PostgresPoolLike;
  now?: () => Date;
  createWorkerId?: () => string;
}) {
  const now = input.now ?? (() => new Date());
  const createWorkerId = input.createWorkerId ?? randomUUID;

  async function publishCompanyOsEvent(event: CanonicalEvent): Promise<CanonicalEvent> {
    required(event.organizationId, 'organization_id');
    required(event.id, 'event_id');
    required(event.idempotencyKey, 'idempotency_key');
    required(event.type, 'event_type');
    required(event.source, 'source');
    required(event.sourceRevision, 'source_revision');
    required(event.observedAt, 'observed_at');
    required(event.correlationId, 'correlation_id');
    const payloadJson = stableJson(event.payload);
    const factFingerprint = fingerprint(event, payloadJson);
    const inserted = await input.pool.query<EventRow>(
      `INSERT INTO companyos_events
        (organization_id, event_id, event_type, payload, source,
         source_revision, observed_at, correlation_id, causation_id,
         idempotency_key, fact_fingerprint)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz, $8, $9, $10, $11)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING cursor, organization_id, event_id, event_type, payload, source,
                 source_revision, observed_at, correlation_id, causation_id,
                 idempotency_key, fact_fingerprint`,
      [
        event.organizationId, event.id, event.type, payloadJson, event.source,
        event.sourceRevision, event.observedAt, event.correlationId,
        event.causationId ?? null, event.idempotencyKey, factFingerprint,
      ],
    );
    if (inserted.rows[0]) return eventFromRow(inserted.rows[0]);
    const existing = await input.pool.query<EventRow>(
      `SELECT cursor, organization_id, event_id, event_type, payload, source,
              source_revision, observed_at, correlation_id, causation_id,
              idempotency_key, fact_fingerprint
         FROM companyos_events
        WHERE organization_id = $1 AND idempotency_key = $2`,
      [event.organizationId, event.idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row || row.fact_fingerprint !== factFingerprint) {
      throw new Error('idempotency_conflict');
    }
    return eventFromRow(row);
  }

  async function claimNextCompanyOsEvent(raw: {
    organizationId: string;
    consumerId: string;
    workerId?: string;
    leaseDurationMs?: number;
  }): Promise<PostgresCompanyOsEventClaim | null> {
    const organizationId = required(raw.organizationId, 'organization_id');
    const consumerId = required(raw.consumerId, 'consumer_id');
    const workerId = required(raw.workerId ?? createWorkerId(), 'worker_id');
    const leaseDurationMs = raw.leaseDurationMs ?? 30_000;
    if (
      !Number.isSafeInteger(leaseDurationMs)
      || leaseDurationMs < 1_000
      || leaseDurationMs > 60 * 60 * 1_000
    ) throw new Error('invalid_lease_duration_ms');
    const claimedAt = now();
    const leaseExpiresAt = new Date(claimedAt.getTime() + leaseDurationMs);
    const claimed = await input.pool.query<ClaimRow>(
      `WITH candidate AS (
         SELECT event.cursor
           FROM companyos_events event
           LEFT JOIN companyos_event_receipts receipt
             ON receipt.consumer_id = $2 AND receipt.event_cursor = event.cursor
           LEFT JOIN companyos_event_claims claim
             ON claim.consumer_id = $2 AND claim.event_cursor = event.cursor
          WHERE event.organization_id = $1
            AND receipt.event_cursor IS NULL
            AND (claim.event_cursor IS NULL OR claim.lease_expires_at <= $4::timestamptz)
          ORDER BY event.cursor
          FOR UPDATE OF event SKIP LOCKED
          LIMIT 1
       ), claimed AS (
         INSERT INTO companyos_event_claims
           (consumer_id, event_cursor, organization_id, owner_id, fence_token,
            claimed_at, lease_expires_at)
         SELECT $2, candidate.cursor, $1, $3, 1, $4::timestamptz, $5::timestamptz
           FROM candidate
         ON CONFLICT (consumer_id, event_cursor) DO UPDATE SET
           organization_id = EXCLUDED.organization_id,
           owner_id = EXCLUDED.owner_id,
           fence_token = companyos_event_claims.fence_token + 1,
           claimed_at = EXCLUDED.claimed_at,
           lease_expires_at = EXCLUDED.lease_expires_at
         WHERE companyos_event_claims.lease_expires_at <= $4::timestamptz
         RETURNING event_cursor, fence_token, lease_expires_at
       )
       SELECT event.cursor, event.organization_id, event.event_id,
              event.event_type, event.payload, event.source,
              event.source_revision, event.observed_at, event.correlation_id,
              event.causation_id, event.idempotency_key,
              claimed.fence_token, claimed.lease_expires_at
         FROM claimed
         JOIN companyos_events event ON event.cursor = claimed.event_cursor`,
      [
        organizationId, consumerId, workerId,
        claimedAt.toISOString(), leaseExpiresAt.toISOString(),
      ],
    );
    const row = claimed.rows[0];
    if (!row) return null;
    return {
      consumerId,
      eventCursor: Number(row.cursor),
      organizationId: row.organization_id,
      ownerId: workerId,
      fenceToken: Number(row.fence_token),
      leaseExpiresAt: iso(row.lease_expires_at),
      event: eventFromRow(row),
    };
  }

  async function completeCompanyOsWatchdogClaim(
    claim: PostgresCompanyOsEventClaim,
  ): Promise<void> {
    const completedAt = now().toISOString();
    await transaction(input.pool, async (client) => {
      const verified = await client.query<EventRow>(
        `SELECT event.cursor, event.organization_id, event.event_id,
                event.event_type, event.payload, event.source,
                event.source_revision, event.observed_at, event.correlation_id,
                event.causation_id, event.idempotency_key
           FROM companyos_event_claims claim
           JOIN companyos_events event ON event.cursor = claim.event_cursor
           LEFT JOIN companyos_event_receipts receipt
             ON receipt.consumer_id = claim.consumer_id
            AND receipt.event_cursor = claim.event_cursor
          WHERE claim.consumer_id = $1 AND claim.event_cursor = $2
            AND claim.organization_id = $3 AND claim.owner_id = $4
            AND claim.fence_token = $5
            AND claim.lease_expires_at > $6::timestamptz
            AND receipt.event_cursor IS NULL
          FOR UPDATE OF claim`,
        [
          required(claim.consumerId, 'consumer_id'), claim.eventCursor,
          required(claim.organizationId, 'organization_id'),
          required(claim.ownerId, 'worker_id'), claim.fenceToken, completedAt,
        ],
      );
      const row = verified.rows[0];
      if (!row) throw new Error('consumer_lease_lost');
      const event = eventFromRow(row);
      const actionable = [
        'owl.price.anomaly',
        'zhilemon.gmv.anomaly',
        'zhilemon.refund.anomaly',
      ].includes(event.type);
      if (actionable) {
        const actionId = `action-${createHash('sha256')
          .update(`${event.organizationId}\0${event.id}`).digest('hex').slice(0, 24)}`;
        const taskId = `task-${createHash('sha256')
          .update(`${actionId}\0human-decision`).digest('hex').slice(0, 24)}`;
        const auditId = `audit-${createHash('sha256')
          .update(`${actionId}\0watchdog.recommendation.created`).digest('hex').slice(0, 24)}`;
        const evidence = JSON.stringify([event.id]);
        await client.query(
          `INSERT INTO companyos_actions
            (action_id, organization_id, source_event_id, title, reason, status,
             evidence_event_ids, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'recommended', $6::jsonb,
                   $7::timestamptz, $7::timestamptz)
           ON CONFLICT (organization_id, source_event_id) DO NOTHING`,
          [
            actionId, event.organizationId, event.id, `调查${event.type}`,
            '平台事件显示经营异常，需调查后再执行副作用动作', evidence, completedAt,
          ],
        );
        await client.query(
          `INSERT INTO companyos_tasks
            (task_id, organization_id, action_id, title, status,
             evidence_event_ids, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'pending_decision', $5::jsonb,
                   $6::timestamptz, $6::timestamptz)
           ON CONFLICT (action_id) DO NOTHING`,
          [
            taskId, event.organizationId, actionId,
            `人工决策：调查${event.type}`, evidence, completedAt,
          ],
        );
        await client.query(
          `INSERT INTO companyos_audit
            (audit_id, organization_id, action_id, action, status, actor,
             evidence_event_ids, created_at)
           VALUES ($1, $2, $3, 'watchdog.recommendation.created',
                   'recommended', 'brand-ceo-agent', $4::jsonb, $5::timestamptz)
           ON CONFLICT (organization_id, action_id, action) DO NOTHING`,
          [auditId, event.organizationId, actionId, evidence, completedAt],
        );
      }
      await client.query(
        `INSERT INTO companyos_event_receipts
          (consumer_id, event_cursor, organization_id, processed_at)
         VALUES ($1, $2, $3, $4::timestamptz)
         ON CONFLICT (consumer_id, event_cursor) DO NOTHING`,
        [claim.consumerId, claim.eventCursor, claim.organizationId, completedAt],
      );
      const released = await client.query(
        `DELETE FROM companyos_event_claims
          WHERE consumer_id = $1 AND event_cursor = $2
            AND organization_id = $3 AND owner_id = $4 AND fence_token = $5`,
        [
          claim.consumerId, claim.eventCursor, claim.organizationId,
          claim.ownerId, claim.fenceToken,
        ],
      );
      if (released.rowCount !== undefined && released.rowCount !== 1) {
        throw new Error('consumer_lease_lost');
      }
    });
  }

  async function inspectCompanyOsWatchdog(raw: {
    organizationId: string;
    workerId?: string;
    limit?: number;
  }): Promise<number> {
    const workerId = required(raw.workerId ?? createWorkerId(), 'worker_id');
    const limit = raw.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('invalid_consumer_limit');
    }
    let processed = 0;
    while (processed < limit) {
      const claim = await claimNextCompanyOsEvent({
        organizationId: raw.organizationId,
        consumerId: 'brand-watchdog-v1',
        workerId,
      });
      if (!claim) return processed;
      await completeCompanyOsWatchdogClaim(claim);
      processed++;
    }
    return processed;
  }

  async function listCompanyOsActions(organizationId: string): Promise<Action[]> {
    const rows = await input.pool.query<Record<string, unknown>>(
      `SELECT action_id, organization_id, title, reason, status,
              evidence_event_ids
         FROM companyos_actions
        WHERE organization_id = $1
        ORDER BY created_at DESC, action_id DESC`,
      [required(organizationId, 'organization_id')],
    );
    return rows.rows.map((row) => ({
      id: String(row.action_id), organizationId: String(row.organization_id),
      title: String(row.title), reason: String(row.reason),
      status: row.status as Action['status'],
      evidenceEventIds: json(row.evidence_event_ids) as string[],
    }));
  }

  async function listCompanyOsEvents(
    organizationId: string,
    eventTypes: readonly string[],
  ): Promise<CanonicalEvent[]> {
    const normalizedOrganizationId = required(organizationId, 'organization_id');
    if (!eventTypes.length || eventTypes.length > 50) throw new Error('invalid_event_types');
    const normalizedTypes = [...new Set(eventTypes.map((type) => required(type, 'event_type')))];
    const rows = await input.pool.query<EventRow>(
      `SELECT cursor, organization_id, event_id, event_type, payload, source,
              source_revision, observed_at, correlation_id, causation_id,
              idempotency_key
         FROM companyos_events
        WHERE organization_id = $1 AND event_type = ANY($2::text[])
        ORDER BY cursor DESC
        LIMIT 10001`,
      [normalizedOrganizationId, normalizedTypes],
    );
    if (rows.rows.length > 10_000) throw new Error('operating_event_limit_exceeded');
    return rows.rows.map(eventFromRow).reverse();
  }

  async function listCompanyOsTasks(organizationId: string): Promise<CompanyOsTask[]> {
    const rows = await input.pool.query<Record<string, unknown>>(
      `SELECT task_id, organization_id, action_id, title, status,
              evidence_event_ids
         FROM companyos_tasks
        WHERE organization_id = $1
        ORDER BY created_at DESC, task_id DESC`,
      [required(organizationId, 'organization_id')],
    );
    return rows.rows.map((row) => ({
      id: String(row.task_id), organizationId: String(row.organization_id),
      actionId: String(row.action_id), title: String(row.title),
      status: row.status as CompanyOsTask['status'],
      evidenceEventIds: json(row.evidence_event_ids) as string[],
    }));
  }

  async function listCompanyOsAudit(organizationId: string): Promise<AuditEntry[]> {
    const rows = await input.pool.query<Record<string, unknown>>(
      `SELECT audit_id, organization_id, action, status, actor,
              evidence_event_ids, created_at
         FROM companyos_audit
        WHERE organization_id = $1
        ORDER BY created_at DESC, audit_id DESC`,
      [required(organizationId, 'organization_id')],
    );
    return rows.rows.map((row) => ({
      id: String(row.audit_id), organizationId: String(row.organization_id),
      action: String(row.action), status: row.status as AuditEntry['status'],
      actor: row.actor as AuditEntry['actor'],
      evidenceEventIds: json(row.evidence_event_ids) as string[],
      at: iso(row.created_at as Date | string),
    }));
  }

  async function decideCompanyOsTask(raw: {
    organizationId: string;
    taskId: string;
    decision: 'approve' | 'reject';
  }): Promise<CompanyOsTask> {
    const organizationId = required(raw.organizationId, 'organization_id');
    const taskId = required(raw.taskId, 'task_id');
    return transaction(input.pool, async (client) => {
      const selected = await client.query<Record<string, unknown>>(
        `SELECT task_id, organization_id, action_id, title, status,
                evidence_event_ids
           FROM companyos_tasks
          WHERE organization_id = $1 AND task_id = $2
          FOR UPDATE`,
        [organizationId, taskId],
      );
      const row = selected.rows[0];
      if (!row) throw new Error('task_not_found');
      const desiredTaskStatus = raw.decision === 'approve' ? 'approved' : 'rejected';
      if (row.status !== 'pending_decision' && row.status !== desiredTaskStatus) {
        throw new Error('task_already_decided');
      }
      if (row.status === 'pending_decision') {
        const actionStatus = raw.decision === 'approve' ? 'queued' : 'rejected';
        const decidedAt = now().toISOString();
        const updated = await client.query(
          `UPDATE companyos_tasks
              SET status = $3, updated_at = $4::timestamptz
            WHERE organization_id = $1 AND task_id = $2
              AND status = 'pending_decision'`,
          [organizationId, taskId, desiredTaskStatus, decidedAt],
        );
        if (updated.rowCount !== undefined && updated.rowCount !== 1) {
          throw new Error('task_already_decided');
        }
        await client.query(
          `UPDATE companyos_actions
              SET status = $3, updated_at = $4::timestamptz
            WHERE organization_id = $1 AND action_id = $2`,
          [organizationId, row.action_id, actionStatus, decidedAt],
        );
        const auditAction = `watchdog.task.${desiredTaskStatus}`;
        const auditId = `audit-${createHash('sha256')
          .update(`${String(row.action_id)}\0${auditAction}`)
          .digest('hex')
          .slice(0, 24)}`;
        await client.query(
          `INSERT INTO companyos_audit
            (audit_id, organization_id, action_id, action, status, actor,
             evidence_event_ids, created_at)
           VALUES ($1, $2, $3, $4, $5, 'human', $6::jsonb, $7::timestamptz)
           ON CONFLICT (organization_id, action_id, action) DO NOTHING`,
          [
            auditId, organizationId, row.action_id, auditAction,
            desiredTaskStatus, JSON.stringify(json(row.evidence_event_ids)), decidedAt,
          ],
        );
        row.status = desiredTaskStatus;
      }
      return {
        id: String(row.task_id),
        organizationId: String(row.organization_id),
        actionId: String(row.action_id),
        title: String(row.title),
        status: row.status as CompanyOsTask['status'],
        evidenceEventIds: json(row.evidence_event_ids) as string[],
      };
    });
  }

  return {
    publishCompanyOsEvent,
    claimNextCompanyOsEvent,
    completeCompanyOsWatchdogClaim,
    inspectCompanyOsWatchdog,
    listCompanyOsEvents,
    listCompanyOsActions,
    listCompanyOsTasks,
    listCompanyOsAudit,
    decideCompanyOsTask,
  };
}

export type PostgresCompanyOsRepository = ReturnType<
  typeof createPostgresCompanyOsRepository
>;
