# Agent Note: Export validated enterprise snapshots

Status: implemented

English | [中文](2026-09-14-enterprise-snapshot-backup.zh.md)

## Problem

The local CRM/ERP store was durable and audited, but the panels did not expose a user-controlled backup action despite offering local business records.

## Decision

Add a header action to both panels that downloads the currently observed, schema-validated enterprise snapshot as a dated JSON file. The panels also accept a backup file, show its validated counts and revision, and require an explicit confirmation before calling the revision-fenced restore route. The Host store performs the replacement atomically and rejects stale confirmations.

## Alternatives considered

**Copy the SQLite file from the browser.** Browser code cannot safely access the Host database path and would bypass the authenticated snapshot contract.

**Add automatic restore on import.** Implicit replacement could destroy newer records; the panel therefore requires a separately reviewed confirmation with revision and format checks.

## Consequences

Operators can retain a portable local snapshot for recovery or audit. Restore requires selecting the file, reviewing the displayed summary, and confirming against the current revision; the panel never restores on file selection alone.

## Acceptance

- CRM and ERP expose the localized download action when a snapshot is available;
- the export contains the complete observed snapshot and a dated filename;
- export does not mutate the store;
- frontend build and tests pass.
