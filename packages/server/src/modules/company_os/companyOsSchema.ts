/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const COMPANY_OS_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'company_os',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS companyos_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        idempotency_key TEXT NOT NULL,
        fact_fingerprint TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(organization_id, event_id),
        UNIQUE(organization_id, idempotency_key),
        UNIQUE(cursor, organization_id)
      );

      CREATE TABLE IF NOT EXISTS companyos_event_receipts (
        consumer_id TEXT NOT NULL,
        event_cursor INTEGER NOT NULL,
        organization_id TEXT NOT NULL,
        processed_at_ms INTEGER NOT NULL,
        PRIMARY KEY(consumer_id, event_cursor),
        FOREIGN KEY(event_cursor, organization_id)
          REFERENCES companyos_events(cursor, organization_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS companyos_event_claims (
        consumer_id TEXT NOT NULL,
        event_cursor INTEGER NOT NULL,
        organization_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        fence_token INTEGER NOT NULL CHECK(fence_token > 0),
        claimed_at_ms INTEGER NOT NULL,
        lease_expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY(consumer_id, event_cursor),
        FOREIGN KEY(event_cursor, organization_id)
          REFERENCES companyos_events(cursor, organization_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS companyos_actions (
        action_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'recommended', 'queued', 'executed', 'failed', 'unknown_outcome'
        )),
        evidence_event_ids_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(organization_id, source_event_id)
      );

      CREATE TABLE IF NOT EXISTS companyos_audit (
        audit_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'recommended', 'executed', 'failed', 'unknown_outcome'
        )),
        actor TEXT NOT NULL,
        evidence_event_ids_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(organization_id, action_id, action),
        FOREIGN KEY(action_id) REFERENCES companyos_actions(action_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_companyos_events_organization_cursor
        ON companyos_events(organization_id, cursor);
      CREATE INDEX IF NOT EXISTS idx_companyos_receipts_organization
        ON companyos_event_receipts(organization_id, consumer_id, event_cursor);
      CREATE INDEX IF NOT EXISTS idx_companyos_claims_expiry
        ON companyos_event_claims(lease_expires_at_ms, consumer_id, event_cursor);
      CREATE INDEX IF NOT EXISTS idx_companyos_actions_organization
        ON companyos_actions(organization_id, status, created_at_ms, action_id);
    `);
  },
};
