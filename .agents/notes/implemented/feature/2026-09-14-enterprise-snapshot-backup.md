# Agent Note: Export validated enterprise snapshots

Status: implemented

English | [中文](2026-09-14-enterprise-snapshot-backup.zh.md)

## Problem

The local CRM/ERP store was durable and audited, but the panels did not expose a user-controlled backup action despite offering local business records.

## Decision

Both panels export the schema-validated enterprise snapshot and command receipts from one SQLite read transaction as dated JSON. Imported receipts must match their audit records. The panels preview counts and require explicit confirmation of the destination revision and restore generation. The Host checks both values under its write lock, atomically replaces business records and receipts, and increments the destination generation without importing the backup's counter. Schema 2 adds that counter to schema 1 stores; legacy wire requests without it belong only to generation zero.

Command preparation and commit both check the generation before considering idempotent replay. Pending approvals and stale pages cannot regain authority when an imported revision repeats. Restore HTTP handlers join the route owner's drain and recheck cancellation after reading the body. The browser serializes restore with commands, invalidates older reads, preserves server conflict categories and requires an authoritative refresh after an uncertain restore response.

CRM and ERP forms and confirmations retain the generation observed when opened. Refreshing or editing a retained draft cannot authorize it against restored records. A refused stale form preserves its inputs and asks the user to copy needed content, cancel and reopen against current records.

## Alternatives considered

**Copy the SQLite file from the browser.** Browser code cannot safely access the Host database path and would bypass the authenticated snapshot contract.

**Add automatic restore on import.** Implicit replacement could destroy newer records; the panel therefore requires a separately reviewed confirmation with revision and format checks.

**Use the imported revision alone.** Restoring an older revision makes old requests valid again. A destination-owned generation preserves audit revision numbers while invalidating those requests.

## Consequences

Operators can recover enterprise records and retain their audit receipts without authorizing requests from a previous database generation. This is an enterprise-only backup, not a complete DSH home export. A lost restore response requires a fresh read before more changes; pending command requests keep their existing explicit idempotent-retry flow.

## Verification

Store tests cover repeated revisions, legacy requests, generation persistence across reopening, schema migration, mismatched receipts and transaction failure rollback. Client tests cover delayed reads, overlapping mutations, lost responses and conflicts; rendered-panel tests cover explicit confirmation and refresh after uncertainty. Tool tests reject an approval that finishes after restore and a stale pagination generation. The Loader business-flow scenario records the generation in model-visible command receipts and verifies JSONL replay.
