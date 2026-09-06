/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { createHash } from 'node:crypto';
import type { Database } from '../data_platform/index.js';
import type { Action, AuditEntry, CanonicalEvent } from './index.js';
import { COMPANY_OS_SCHEMA_CONTRIBUTOR } from './companyOsSchema.js';

interface EventRow {
  cursor: number;
  organization_id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  source: string;
  source_revision: string;
  observed_at: string;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string;
  fact_fingerprint: string;
}

export interface CompanyOsEventStore {
  db(): Database;
  now(): number;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw new Error(`invalid_${field}`);
  return normalized;
}

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_event_payload');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(',')}]`;
  if (typeof value !== 'object') throw new Error('invalid_event_payload');
  if (seen.has(value)) throw new Error('invalid_event_payload');
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
    payload: JSON.parse(row.payload_json) as unknown,
    source: row.source,
    sourceRevision: row.source_revision,
    observedAt: row.observed_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id ?? undefined,
    idempotencyKey: row.idempotency_key,
  };
}

export class DurableCompanyOsEventBus {
  constructor(private readonly store: CompanyOsEventStore) {
    COMPANY_OS_SCHEMA_CONTRIBUTOR.apply(store.db());
  }

  publish(event: CanonicalEvent): CanonicalEvent {
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
    const database = this.store.db();
    const existing = database.prepare(
      `SELECT cursor, organization_id, event_id, event_type, payload_json, source,
              source_revision, observed_at, correlation_id, causation_id,
              idempotency_key, fact_fingerprint
         FROM companyos_events
        WHERE organization_id = ? AND idempotency_key = ?`,
    ).get(event.organizationId, event.idempotencyKey) as EventRow | undefined;
    if (existing) {
      if (existing.fact_fingerprint !== factFingerprint) throw new Error('idempotency_conflict');
      return eventFromRow(existing);
    }
    database.prepare(
      `INSERT INTO companyos_events
        (organization_id, event_id, event_type, payload_json, source,
         source_revision, observed_at, correlation_id, causation_id,
         idempotency_key, fact_fingerprint, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.organizationId, event.id, event.type, payloadJson, event.source,
      event.sourceRevision, event.observedAt, event.correlationId,
      event.causationId ?? null, event.idempotencyKey, factFingerprint,
      this.store.now(),
    );
    return event;
  }

  consume(
    consumerId: string,
    handler: (event: CanonicalEvent) => void,
    organizationId?: string,
  ): number {
    required(consumerId, 'consumer_id');
    if (organizationId !== undefined) required(organizationId, 'organization_id');
    const database = this.store.db();
    const rows = database.prepare(
      `SELECT event.cursor, event.organization_id, event.event_id, event.event_type,
              event.payload_json, event.source, event.source_revision,
              event.observed_at, event.correlation_id, event.causation_id,
              event.idempotency_key, event.fact_fingerprint
         FROM companyos_events event
         LEFT JOIN companyos_event_receipts receipt
           ON receipt.consumer_id = ? AND receipt.event_cursor = event.cursor
        WHERE receipt.event_cursor IS NULL
          AND (? IS NULL OR event.organization_id = ?)
        ORDER BY event.cursor ASC`,
    ).all(consumerId, organizationId ?? null, organizationId ?? null) as unknown as EventRow[];
    let count = 0;
    for (const row of rows) {
      handler(eventFromRow(row));
      database.prepare(
        `INSERT OR IGNORE INTO companyos_event_receipts
          (consumer_id, event_cursor, organization_id, processed_at_ms)
         VALUES (?, ?, ?, ?)`,
      ).run(consumerId, row.cursor, row.organization_id, this.store.now());
      count++;
    }
    return count;
  }
}

interface ActionRow {
  action_id: string;
  organization_id: string;
  title: string;
  reason: string;
  status: Action['status'];
  evidence_event_ids_json: string;
}

export class DurableBrandWatchdog {
  constructor(
    private readonly store: CompanyOsEventStore,
    private readonly bus = new DurableCompanyOsEventBus(store),
  ) {}

  inspect(): number {
    return this.inspectEvents();
  }

  inspectOrganization(organizationId: string): number {
    required(organizationId, 'organization_id');
    return this.inspectEvents(organizationId);
  }

  private inspectEvents(organizationId?: string): number {
    return this.bus.consume('brand-watchdog-v1', (event) => {
      if (![
        'owl.price.anomaly',
        'zhilemon.gmv.anomaly',
        'zhilemon.refund.anomaly',
      ].includes(event.type)) return;
      this.projectRecommendation(event);
    }, organizationId);
  }

  listActions(organizationId: string): Action[] {
    required(organizationId, 'organization_id');
    return (this.store.db().prepare(
      `SELECT action_id, organization_id, title, reason, status,
              evidence_event_ids_json
         FROM companyos_actions
        WHERE organization_id = ?
        ORDER BY created_at_ms DESC, action_id DESC`,
    ).all(organizationId) as unknown as ActionRow[]).map((row) => ({
      id: row.action_id,
      organizationId: row.organization_id,
      title: row.title,
      reason: row.reason,
      status: row.status,
      evidenceEventIds: JSON.parse(row.evidence_event_ids_json) as string[],
    }));
  }

  listAudit(organizationId: string): AuditEntry[] {
    required(organizationId, 'organization_id');
    return (this.store.db().prepare(
      `SELECT audit_id, organization_id, action, status, actor,
              evidence_event_ids_json, created_at_ms
         FROM companyos_audit
        WHERE organization_id = ?
        ORDER BY created_at_ms DESC, audit_id DESC`,
    ).all(organizationId) as unknown as Array<{
      audit_id: string;
      organization_id: string;
      action: string;
      status: AuditEntry['status'];
      actor: AuditEntry['actor'];
      evidence_event_ids_json: string;
      created_at_ms: number;
    }>).map((row) => ({
      id: row.audit_id,
      organizationId: row.organization_id,
      action: row.action,
      status: row.status,
      actor: row.actor,
      evidenceEventIds: JSON.parse(row.evidence_event_ids_json) as string[],
      at: new Date(row.created_at_ms).toISOString(),
    }));
  }

  private projectRecommendation(event: CanonicalEvent): void {
    const database = this.store.db();
    const actionId = `action-${createHash('sha256')
      .update(`${event.organizationId}\0${event.id}`)
      .digest('hex')
      .slice(0, 24)}`;
    const auditId = `audit-${createHash('sha256')
      .update(`${actionId}\0watchdog.recommendation.created`)
      .digest('hex')
      .slice(0, 24)}`;
    const at = this.store.now();
    const evidence = JSON.stringify([event.id]);
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(
        `INSERT OR IGNORE INTO companyos_actions
          (action_id, organization_id, source_event_id, title, reason, status,
           evidence_event_ids_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 'recommended', ?, ?, ?)`,
      ).run(
        actionId,
        event.organizationId,
        event.id,
        `调查${event.type}`,
        '平台事件显示经营异常，需调查后再执行副作用动作',
        evidence,
        at,
        at,
      );
      database.prepare(
        `INSERT OR IGNORE INTO companyos_audit
          (audit_id, organization_id, action_id, action, status, actor,
           evidence_event_ids_json, created_at_ms)
         VALUES (?, ?, ?, 'watchdog.recommendation.created', 'recommended',
                 'brand-ceo-agent', ?, ?)`,
      ).run(auditId, event.organizationId, actionId, evidence, at);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
