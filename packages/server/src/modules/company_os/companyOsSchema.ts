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
        UNIQUE(organization_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS companyos_event_receipts (
        consumer_id TEXT NOT NULL,
        event_cursor INTEGER NOT NULL,
        organization_id TEXT NOT NULL,
        processed_at_ms INTEGER NOT NULL,
        PRIMARY KEY(consumer_id, event_cursor),
        FOREIGN KEY(event_cursor) REFERENCES companyos_events(cursor) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_companyos_events_organization_cursor
        ON companyos_events(organization_id, cursor);
      CREATE INDEX IF NOT EXISTS idx_companyos_receipts_organization
        ON companyos_event_receipts(organization_id, consumer_id, event_cursor);
    `);
  },
};
