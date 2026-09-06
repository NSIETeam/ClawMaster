/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '../data_platform/index.js';
import type { Action } from './index.js';
import { COMPANY_OS_SCHEMA_CONTRIBUTOR } from './companyOsSchema.js';

export type ActionExecutionStatus = 'running' | 'executed' | 'failed' | 'unknown_outcome';

export type ActionConnectorResult =
  | { outcome: 'committed'; receiptId: string; summary: string }
  | { outcome: 'rejected'; error: string }
  | { outcome: 'unknown'; error: string };

export interface CompanyOsActionConnector {
  provider: string;
  execute(input: {
    action: Readonly<Action>;
    idempotencyKey: string;
  }): Promise<ActionConnectorResult>;
  reconcile?(input: {
    action: Readonly<Action>;
    idempotencyKey: string;
  }): Promise<ActionConnectorResult>;
}

export interface ActionExecutionRecord {
  organizationId: string;
  actionId: string;
  provider: string;
  idempotencyKey: string;
  status: ActionExecutionStatus;
  attempt: number;
  fenceToken: number;
  providerReceiptId?: string;
  resultSummary?: string;
  lastError?: string;
}

type Store = { db(): DatabaseHandle; now(): number };
type Row = {
  organization_id: string; action_id: string; provider: string;
  idempotency_key: string; operation_fingerprint: string;
  status: ActionExecutionStatus; attempt: number; owner_id: string | null;
  fence_token: number; lease_expires_at_ms: number | null;
  provider_receipt_id: string | null; result_summary: string | null;
  last_error: string | null;
};

const clean = (value: string, field: string): string => {
  const result = value.trim();
  const hasControlCharacter = [...result].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (!result || result.length > 512 || hasControlCharacter) {
    throw new Error(`invalid_${field}`);
  }
  return result;
};

const safeError = (value: string): string => value
  .replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]')
  .slice(0, 500);

function fromRow(row: Row): ActionExecutionRecord {
  return {
    organizationId: row.organization_id, actionId: row.action_id,
    provider: row.provider, idempotencyKey: row.idempotency_key,
    status: row.status, attempt: row.attempt, fenceToken: row.fence_token,
    ...(row.provider_receipt_id ? { providerReceiptId: row.provider_receipt_id } : {}),
    ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

export class DurableCompanyOsActionExecutor {
  private readonly ownerId: string;
  private readonly leaseDurationMs: number;

  constructor(
    private readonly store: Store,
    options: {
      ownerId?: string;
      leaseDurationMs?: number;
      allow: (input: { action: Readonly<Action>; provider: string }) => boolean | Promise<boolean>;
    },
  ) {
    COMPANY_OS_SCHEMA_CONTRIBUTOR.apply(store.db());
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.allow = options.allow;
  }

  private readonly allow: (
    input: { action: Readonly<Action>; provider: string },
  ) => boolean | Promise<boolean>;

  get(organizationId: string, actionId: string): ActionExecutionRecord | null {
    const row = this.store.db().prepare(
      `SELECT * FROM companyos_action_executions
        WHERE organization_id = ? AND action_id = ?`,
    ).get(clean(organizationId, 'organization_id'), clean(actionId, 'action_id')) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  async execute(
    organizationId: string,
    actionId: string,
    connector: CompanyOsActionConnector,
  ): Promise<ActionExecutionRecord> {
    const action = this.loadQueuedAction(organizationId, actionId);
    const provider = clean(connector.provider, 'provider');
    if (!(await this.allow({ action, provider }))) throw new Error('action_execution_blocked');
    const claim = this.claim(action, provider);
    if (claim.status !== 'running') return claim;
    let result: ActionConnectorResult;
    try {
      result = await connector.execute({ action, idempotencyKey: claim.idempotencyKey });
    } catch (error) {
      result = { outcome: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    return this.finish(action, claim, result);
  }

  async reconcile(
    organizationId: string,
    actionId: string,
    connector: CompanyOsActionConnector,
  ): Promise<ActionExecutionRecord> {
    const action = this.loadAction(organizationId, actionId);
    const current = this.get(organizationId, actionId);
    if (!current || current.status !== 'unknown_outcome') throw new Error('action_not_awaiting_reconciliation');
    if (current.provider !== connector.provider) throw new Error('action_connector_mismatch');
    if (!connector.reconcile) throw new Error('action_connector_cannot_reconcile');
    let result: ActionConnectorResult;
    try {
      result = await connector.reconcile({ action, idempotencyKey: current.idempotencyKey });
    } catch (error) {
      result = { outcome: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    return this.finish(action, current, result, true);
  }

  private loadAction(organizationId: string, actionId: string): Action {
    const row = this.store.db().prepare(
      `SELECT action_id, organization_id, title, reason, status, evidence_event_ids_json
         FROM companyos_actions WHERE organization_id = ? AND action_id = ?`,
    ).get(clean(organizationId, 'organization_id'), clean(actionId, 'action_id')) as
      | { action_id: string; organization_id: string; title: string; reason: string; status: Action['status']; evidence_event_ids_json: string }
      | undefined;
    if (!row) throw new Error('action_not_found');
    return { id: row.action_id, organizationId: row.organization_id, title: row.title,
      reason: row.reason, status: row.status,
      evidenceEventIds: JSON.parse(row.evidence_event_ids_json) as string[] };
  }

  private loadQueuedAction(organizationId: string, actionId: string): Action {
    const action = this.loadAction(organizationId, actionId);
    const existing = this.get(organizationId, actionId);
    if (existing) return action;
    if (action.status !== 'queued') throw new Error('action_not_approved');
    return action;
  }

  private claim(action: Action, provider: string): ActionExecutionRecord {
    const db = this.store.db();
    const at = this.store.now();
    const idempotencyKey = `companyos:${action.organizationId}:${action.id}`;
    const fingerprint = createHash('sha256').update(JSON.stringify([
      action.organizationId, action.id, action.title, action.reason, provider,
    ])).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare(
        `SELECT * FROM companyos_action_executions
          WHERE organization_id = ? AND action_id = ?`,
      ).get(action.organizationId, action.id) as Row | undefined;
      if (existing) {
        if (existing.provider !== provider || existing.operation_fingerprint !== fingerprint) {
          throw new Error('action_execution_conflict');
        }
        if (existing.status === 'running' && (existing.lease_expires_at_ms ?? 0) <= at) {
          this.transition(db, action, existing, 'unknown_outcome', undefined,
            'execution lease expired; reconcile before retry', 'worker lease expired before completion');
          db.exec('COMMIT');
          return this.get(action.organizationId, action.id)!;
        }
        db.exec('COMMIT');
        return fromRow(existing);
      }
      db.prepare(
        `INSERT INTO companyos_action_executions
          (organization_id, action_id, provider, idempotency_key, operation_fingerprint,
           status, attempt, owner_id, fence_token, lease_expires_at_ms,
           created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 'running', 1, ?, 1, ?, ?, ?)`,
      ).run(action.organizationId, action.id, provider, idempotencyKey, fingerprint,
        this.ownerId, at + this.leaseDurationMs, at, at);
      db.exec('COMMIT');
      return this.get(action.organizationId, action.id)!;
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  private finish(
    action: Action,
    claim: ActionExecutionRecord,
    result: ActionConnectorResult,
    reconciliation = false,
  ): ActionExecutionRecord {
    const db = this.store.db();
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare(
        `SELECT * FROM companyos_action_executions
          WHERE organization_id = ? AND action_id = ?`,
      ).get(action.organizationId, action.id) as Row | undefined;
      if (!current || (!reconciliation && (
        current.status !== 'running' || current.owner_id !== this.ownerId
        || current.fence_token !== claim.fenceToken
      ))) throw new Error('action_execution_lease_lost');
      if (reconciliation && current.status !== 'unknown_outcome') {
        throw new Error('action_not_awaiting_reconciliation');
      }
      const status: ActionExecutionStatus = result.outcome === 'committed'
        ? 'executed' : result.outcome === 'rejected' ? 'failed' : 'unknown_outcome';
      this.transition(db, action, current, status,
        result.outcome === 'committed' ? result.receiptId : undefined,
        result.outcome === 'committed' ? result.summary : undefined,
        result.outcome === 'committed' ? undefined : result.error);
      db.exec('COMMIT');
      return this.get(action.organizationId, action.id)!;
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  private transition(
    db: DatabaseHandle, action: Action, current: Row, status: Exclude<ActionExecutionStatus, 'running'>,
    receiptId?: string, summary?: string, error?: string,
  ): void {
    const at = this.store.now();
    db.prepare(
      `UPDATE companyos_action_executions SET status = ?, owner_id = NULL,
        lease_expires_at_ms = NULL, provider_receipt_id = ?, result_summary = ?,
        last_error = ?, updated_at_ms = ?
       WHERE organization_id = ? AND action_id = ?`,
    ).run(status, receiptId ?? null, summary ?? null, error ? safeError(error) : null,
      at, action.organizationId, action.id);
    db.prepare(
      `UPDATE companyos_actions SET status = ?, updated_at_ms = ?
        WHERE organization_id = ? AND action_id = ?`,
    ).run(status, at, action.organizationId, action.id);
    if (status === 'executed') {
      db.prepare(
        `UPDATE companyos_tasks SET status = 'completed', updated_at_ms = ?
          WHERE organization_id = ? AND action_id = ? AND status = 'approved'`,
      ).run(at, action.organizationId, action.id);
    }
    const auditAction = `watchdog.action.${status}`;
    const auditId = `audit-${createHash('sha256').update(`${action.id}\0${auditAction}`).digest('hex').slice(0, 24)}`;
    db.prepare(
      `INSERT OR IGNORE INTO companyos_audit
        (audit_id, organization_id, action_id, action, status, actor,
         evidence_event_ids_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, 'brand-ceo-agent', ?, ?)`,
    ).run(auditId, action.organizationId, action.id, auditAction, status,
      JSON.stringify(action.evidenceEventIds), at);
    void current;
  }
}
