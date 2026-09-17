# Agent Note: Enterprise responsibility history survives restore

Status: implemented

English | [中文](2026-09-16-enterprise-responsibility-history.zh.md)

## Problem

A business backup replaces records and their revisioned before/after audit. Treating that history as the sole responsibility log erases the evidence for intervening writes when a backup is restored.

## Decision

SQLite schema 3 owns an append-only responsibility table outside the restore payload. Successful writes and responsibility entries share the business transaction. Restore records retain the backup digest and both revision/generation pairs; independent receipts make explicit restore retries idempotent after a lost response. Failed, denied and cancelled operations record distinct outcomes. Authenticated authorization and task consumers record unsuccessful attempts after identity resolution, including role revocation during approval. Each attempt records only operation/command metadata and a fixed reason code; request bodies, search text and exception messages stay outside responsibility history. Missing, unbound or foreign-organization identities do not produce human attribution. Request JSON cannot choose actor or approval fields. HTTP identifies the authenticated local device operator; tools identify the owning Session and call. Enterprise approval metadata carries an authority-issued approval and approver ID; local DSH one-shot approval carries only the `allowed-once` result and has no durable approver identity or approval ID. Unlabelled approval objects from earlier records are retained as historical, unverified metadata. Existing business history imports with unknown actor metadata.

Responsibility readers iterate SQLite rows and return complete records within configured row and encoded-response byte budgets. The same reader accounts for HTTP JSON or the full DSH structured-value and rendered-text envelope. Exclusive sequence cursors continue filtered append-only history; a single oversized record fails at its cursor instead of disappearing or yielding an empty continuation. Existing records and hashes remain unchanged, and raising the budget can read that record. The HTTP consumer enforces these limits after current audit authorization.

The released request, snapshot and backup types retain their restore generation and command receipts. Both model tool input schemas expose the generation used by the HTTP/domain parser; a reviewed post-restore request can advance in the new generation, while stale commands and pagination remain rejected.

The [business backup decision](../feature/2026-09-14-enterprise-snapshot-backup.md) remains authoritative for portable business snapshots and exact stock restoration. Responsibility history is separate and is neither replaced nor exported by that operation.

Schema changes and their version marker share the same transaction as organization admission and history validation. Committing a generation column before the organization check leaves a rejected schema 1 database marked as schema 1 with that column already present, so retries fail. Rejection preserves the prior schema and records for a valid local retry.

## Alternatives considered

**Keeping responsibility in the restored business audit.** Replacing that table necessarily loses evidence about changes made after the backup.

**A separate append-only file.** A file append cannot commit atomically with SQLite mutations. The shared database transaction prevents a successful business change without its success record.

## Consequences

Hash verification detects local inconsistency, not a malicious machine administrator who can replace the entire database. Enterprise retention still requires an independently controlled archive. History grows until an explicit retention design is implemented. The migration does not invent old identities. Local device labels do not identify enterprise members. External membership and policy changes are not independently observable by the desktop Host; enterprise policy-change auditing requires an authenticated authority event feed. Governance tests cover restore continuity, response-loss replay, transaction failure, forged actor fields, audit-write rollback, old-schema import and hash-chain damage. The A→B→restore regression retains B's actor and approval facts alongside the restore operator, independent approver, backup digest and before/after generation and revision pairs after database reopen; exact restore replay adds no entry. Task dispatch outcomes reference the persisted start command, task revision, DSH request and Session IDs; an uncertain result can be resolved by appending one terminal fact under the same request ID, while exact replays return the recorded fact. A real organization identity provider and desktop business acceptance remain separate integration work.
