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
import type {
  ActionConnectorResult,
  ActionExecutionRecord,
} from './actionExecution.js';
import { operatingFactKey } from './operatingFactIdentity.js';

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

interface ActionExecutionRow extends Record<string, unknown> {
  organization_id: string;
  action_id: string;
  provider: string;
  idempotency_key: string;
  operation_fingerprint: string;
  status: ActionExecutionRecord['status'];
  attempt: number | string;
  owner_id: string | null;
  fence_token: number | string;
  lease_expires_at: Date | string | null;
  provider_receipt_id: string | null;
  result_summary: string | null;
  last_error: string | null;
}

export interface PostgresCompanyOsActionClaim extends ActionExecutionRecord {
  action: Action;
  ownerId?: string;
  leaseExpiresAt?: string;
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

function actionExecutionFromRow(row: ActionExecutionRow): ActionExecutionRecord {
  return {
    organizationId: row.organization_id,
    actionId: row.action_id,
    provider: row.provider,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempt: Number(row.attempt),
    fenceToken: Number(row.fence_token),
    ...(row.provider_receipt_id ? { providerReceiptId: row.provider_receipt_id } : {}),
    ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function boundedError(value: string): string {
  return value.replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]').slice(0, 500);
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
    const factKey = operatingFactKey(event);
    const inserted = await input.pool.query<EventRow>(
      `WITH inserted AS (
       INSERT INTO companyos_events
        (organization_id, event_id, event_type, payload, source,
         source_revision, observed_at, correlation_id, causation_id,
         idempotency_key, fact_fingerprint)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz, $8, $9, $10, $11)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING cursor, organization_id, event_id, event_type, payload, source,
                 source_revision, observed_at, correlation_id, causation_id,
                 idempotency_key, fact_fingerprint
       ), projected AS (
         INSERT INTO companyos_latest_facts
           (organization_id, event_type, fact_key, event_cursor, observed_at)
         SELECT organization_id, event_type, $12::text, cursor, observed_at
         FROM inserted
         WHERE $12::text IS NOT NULL
         ON CONFLICT (organization_id, event_type, fact_key) DO UPDATE SET
           event_cursor = EXCLUDED.event_cursor,
           observed_at = EXCLUDED.observed_at
         WHERE EXCLUDED.observed_at > companyos_latest_facts.observed_at
            OR (EXCLUDED.observed_at = companyos_latest_facts.observed_at
                AND EXCLUDED.event_cursor > companyos_latest_facts.event_cursor)
       )
       SELECT cursor, organization_id, event_id, event_type, payload, source,
              source_revision, observed_at, correlation_id, causation_id,
              idempotency_key, fact_fingerprint
       FROM inserted`,
      [
        event.organizationId, event.id, event.type, payloadJson, event.source,
        event.sourceRevision, event.observedAt, event.correlationId,
        event.causationId ?? null, event.idempotencyKey, factFingerprint, factKey,
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

  async function listLatestCompanyOsFacts(
    organizationId: string,
    eventTypes: readonly string[],
  ): Promise<CanonicalEvent[]> {
    const normalizedOrganizationId = required(organizationId, 'organization_id');
    if (!eventTypes.length || eventTypes.length > 50) throw new Error('invalid_event_types');
    const normalizedTypes = [...new Set(eventTypes.map((type) => required(type, 'event_type')))];
    const rows = await input.pool.query<EventRow>(
      `SELECT event.cursor, event.organization_id, event.event_id, event.event_type,
              event.payload, event.source, event.source_revision, event.observed_at,
              event.correlation_id, event.causation_id, event.idempotency_key
         FROM companyos_latest_facts latest
         JOIN companyos_events event
           ON event.cursor = latest.event_cursor
          AND event.organization_id = latest.organization_id
        WHERE latest.organization_id = $1
          AND latest.event_type = ANY($2::text[])
        ORDER BY event.cursor ASC`,
      [normalizedOrganizationId, normalizedTypes],
    );
    return rows.rows.map(eventFromRow);
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

  async function claimCompanyOsActionExecution(raw: {
    organizationId: string;
    actionId: string;
    provider: string;
    workerId: string;
    leaseDurationMs?: number;
  }): Promise<PostgresCompanyOsActionClaim> {
    const organizationId = required(raw.organizationId, 'organization_id');
    const actionId = required(raw.actionId, 'action_id');
    const provider = required(raw.provider, 'provider');
    const workerId = required(raw.workerId, 'worker_id');
    const leaseDurationMs = raw.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 600_000) {
      throw new Error('invalid_action_lease_duration');
    }
    return transaction(input.pool, async (client) => {
      const selected = await client.query<Record<string, unknown>>(
        `SELECT action.action_id, action.organization_id, action.title, action.reason,
                action.status AS action_status, action.evidence_event_ids,
                execution.provider, execution.idempotency_key,
                execution.operation_fingerprint, execution.status,
                execution.attempt, execution.owner_id, execution.fence_token,
                execution.lease_expires_at, execution.provider_receipt_id,
                execution.result_summary, execution.last_error
           FROM companyos_actions action
           LEFT JOIN companyos_action_executions execution
             ON execution.organization_id = action.organization_id
            AND execution.action_id = action.action_id
          WHERE action.organization_id = $1 AND action.action_id = $2
          FOR UPDATE OF action`,
        [organizationId, actionId],
      );
      const row = selected.rows[0];
      if (!row) throw new Error('action_not_found');
      const action: Action = {
        id: String(row.action_id), organizationId: String(row.organization_id),
        title: String(row.title), reason: String(row.reason),
        status: row.action_status as Action['status'],
        evidenceEventIds: json(row.evidence_event_ids) as string[],
      };
      const idempotencyKey = `companyos:${organizationId}:${actionId}`;
      const operationFingerprint = createHash('sha256').update(JSON.stringify([
        organizationId, actionId, action.title, action.reason, provider,
      ])).digest('hex');
      if (row.idempotency_key) {
        if (row.provider !== provider || row.operation_fingerprint !== operationFingerprint) {
          throw new Error('action_execution_conflict');
        }
        const execution = actionExecutionFromRow(row as unknown as ActionExecutionRow);
        const leaseExpired = execution.status === 'running'
          && new Date(String(row.lease_expires_at)).getTime() <= now().getTime();
        if (leaseExpired) {
          const at = now().toISOString();
          await client.query(
            `UPDATE companyos_action_executions
                SET status = 'unknown_outcome', owner_id = NULL,
                    lease_expires_at = NULL,
                    last_error = 'worker lease expired before completion',
                    result_summary = 'execution lease expired; reconcile before retry',
                    updated_at = $3::timestamptz
              WHERE organization_id = $1 AND action_id = $2 AND status = 'running'`,
            [organizationId, actionId, at],
          );
          await projectPostgresActionOutcome(client, action, 'unknown_outcome', at);
          return { ...execution, status: 'unknown_outcome',
            lastError: 'worker lease expired before completion', action };
        }
        return { ...execution, action };
      }
      if (action.status !== 'queued') throw new Error('action_not_approved');
      const claimedAt = now();
      const leaseExpiresAt = new Date(claimedAt.getTime() + leaseDurationMs).toISOString();
      const inserted = await client.query<ActionExecutionRow>(
        `INSERT INTO companyos_action_executions
          (organization_id, action_id, provider, idempotency_key,
           operation_fingerprint, status, attempt, owner_id, fence_token,
           lease_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'running', 1, $6, 1,
                 $7::timestamptz, $8::timestamptz, $8::timestamptz)
         RETURNING *`,
        [organizationId, actionId, provider, idempotencyKey,
          operationFingerprint, workerId, leaseExpiresAt, claimedAt.toISOString()],
      );
      return { ...actionExecutionFromRow(inserted.rows[0]!), action,
        ownerId: workerId, leaseExpiresAt };
    });
  }

  async function finishCompanyOsActionExecution(raw: {
    claim: PostgresCompanyOsActionClaim;
    result: ActionConnectorResult;
    reconciliation?: boolean;
  }): Promise<ActionExecutionRecord> {
    const { claim, result } = raw;
    const status: ActionExecutionRecord['status'] = result.outcome === 'committed'
      ? 'executed' : result.outcome === 'rejected' ? 'failed' : 'unknown_outcome';
    return transaction(input.pool, async (client) => {
      const at = now().toISOString();
      const expectedStatus = raw.reconciliation ? 'unknown_outcome' : 'running';
      const updated = await client.query<ActionExecutionRow>(
        `UPDATE companyos_action_executions
            SET status = $5, owner_id = NULL, lease_expires_at = NULL,
                provider_receipt_id = $6, result_summary = $7,
                last_error = $8, updated_at = $9::timestamptz
          WHERE organization_id = $1 AND action_id = $2 AND provider = $3
            AND status = $4
            AND ($4 = 'unknown_outcome' OR (
              owner_id = $10 AND fence_token = $11
              AND lease_expires_at > $9::timestamptz
            ))
          RETURNING *`,
        [claim.organizationId, claim.actionId, claim.provider, expectedStatus, status,
          result.outcome === 'committed' ? required(result.receiptId, 'provider_receipt_id') : null,
          result.outcome === 'committed' ? result.summary.slice(0, 500) : null,
          result.outcome === 'committed' ? null : boundedError(result.error),
          at, claim.ownerId ?? null, claim.fenceToken],
      );
      if (!updated.rows[0]) throw new Error('action_execution_lease_lost');
      await projectPostgresActionOutcome(client, claim.action, status, at);
      return actionExecutionFromRow(updated.rows[0]);
    });
  }

  async function projectPostgresActionOutcome(
    client: PostgresClientLike,
    action: Action,
    status: Exclude<ActionExecutionRecord['status'], 'running'>,
    at: string,
  ): Promise<void> {
    await client.query(
      `UPDATE companyos_actions SET status = $3, updated_at = $4::timestamptz
        WHERE organization_id = $1 AND action_id = $2`,
      [action.organizationId, action.id, status, at],
    );
    if (status === 'executed') {
      await client.query(
        `UPDATE companyos_tasks SET status = 'completed', updated_at = $3::timestamptz
          WHERE organization_id = $1 AND action_id = $2 AND status = 'approved'`,
        [action.organizationId, action.id, at],
      );
    }
    const auditAction = `watchdog.action.${status}`;
    const auditId = `audit-${createHash('sha256')
      .update(`${action.id}\0${auditAction}`).digest('hex').slice(0, 24)}`;
    await client.query(
      `INSERT INTO companyos_audit
        (audit_id, organization_id, action_id, action, status, actor,
         evidence_event_ids, created_at)
       VALUES ($1, $2, $3, $4, $5, 'brand-ceo-agent', $6::jsonb, $7::timestamptz)
       ON CONFLICT (organization_id, action_id, action) DO NOTHING`,
      [auditId, action.organizationId, action.id, auditAction, status,
        JSON.stringify(action.evidenceEventIds), at],
    );
  }

  return {
    publishCompanyOsEvent,
    claimNextCompanyOsEvent,
    completeCompanyOsWatchdogClaim,
    inspectCompanyOsWatchdog,
    listLatestCompanyOsFacts,
    listCompanyOsActions,
    listCompanyOsTasks,
    listCompanyOsAudit,
    decideCompanyOsTask,
    claimCompanyOsActionExecution,
    finishCompanyOsActionExecution,
  };
}

export type PostgresCompanyOsRepository = ReturnType<
  typeof createPostgresCompanyOsRepository
>;
