# Agent Note: Enterprise backup workers preserve authority and rollback under cancellation

Status: implemented

English | [中文](2026-09-16-enterprise-backup-workers.zh.md)

## Problem

A complete backup assembled, cloned and serialized on the Host makes memory and event-loop stalls proportional to business history. Moving that same object through worker messages duplicates it again. Restoring after an approval wait also requires current authority, the reviewed database versions and a reliable distinction between cancellation and a lost success response.

## Decision

The [backup Host](../../../../frontends/dsh/src/enterprise-backup-host.ts) bounds ingress before consuming bodies, spools private files and sends workers paths and small envelopes. A read-only worker exports one SQLite snapshot by row. Import preparation parses and normalizes an exclusively owned object one row at a time, retaining record, reference, audit-continuity and receipt-content validation. Configured file bytes, concurrent jobs, prepared-file slots, worker heaps and lifetimes bound admitted work; they do not impose a hard RSS cap on native allocations.

Prepared imports belong to one organization, actor and initiating principal. The worker receives a writable database target only after exact approval; it compares generation/revision inside its transaction. It pauses before COMMIT while the Host rechecks current membership. Ordinary writes refuse writer contention immediately during that interval, keeping the Host available to finish or cancel the worker. Disposal and cancellation wait for worker exit, whose SQLite teardown rolls back an uncommitted transaction.

Restore success, responsibility metadata and its receipt commit together. A receipt binds the canonical backup digest, reviewed versions and trusted owner; replay never replaces records again. After worker exit the Host checks that receipt before reporting cancellation. The browser retains an uncertain request across panel navigation and explicitly checks the original command, even after its prepared file disappears. Refreshing unrelated records does not settle the mutation. Browser reload still loses this pending in-memory request, requiring manual inspection of durable records.

Portable format 1 remains JSON. The pre-stable HTTP interface uses raw-file preparation and a small restore acknowledgement, so Host, browser and the packaged private worker deploy together. Direct synchronous store methods serve maintenance callers only. The [paged-record decision](2026-09-16-enterprise-paged-workspace.md) remains active for ordinary reads and writes; this note owns explicit file operations.

The executor is a fixed private Node artifact with no package bin, public argv or application profile. The existing DSH subprocess service exposes streams but no IPC channel; the Host uses a private fork with an explicit minimal environment, ignored stdio and metadata-only IPC. It starts no descendants, waits for process close before releasing storage, and exports no general process-launch API. DSH remains the application launcher.

The worker appends the successful responsibility record only after the final Host authorization check. The record retains the exact consumed approval and the policy version observed at that check; a changed actor, principal, organization or approval cannot finalize the transaction.

## Alternatives considered

**Share the Host process through worker threads.** A tested Node 24 JSON parse at a 32 MiB worker heap cap triggers fatal process OOM, terminating the Host rather than producing a catchable worker error. A private process isolates this failure and returns a recoverable storage error after exit.

**Clone a complete backup into a worker.** Structured cloning keeps a second whole-store allocation on the Host and delays cancellation during message preparation.

**Announce cancellation after posting an abort message.** A synchronous worker cannot receive that message until its work finishes and may commit after the operator sees cancellation. Waiting for termination and checking the durable receipt establishes the actual outcome.

**Remove validation to lower memory.** It admits inconsistent references and receipts. In-place row normalization removes duplicate retained graphs while preserving semantic checks.

## Consequences

[Private-process route regressions](../../../../frontends/dsh/tests/enterprise-backup-worker.test.mjs) exercise actual SQLite transactions, byte limits before body reads, concurrent slow bodies, expiry, approval and final-commit revocation, and cancellation followed by an independent writer acquiring SQLite immediately. [Client tests](../../../../frontends/dsh/tests/enterprise-backup-client.test.mjs) drop a committed response and recover its receipt without replacing later edits. [Rendered UI tests](../../../../frontends/dsh/tests/enterprise-restore.client.spec.tsx) cover file preparation, review, cancellation and result checks. The [capacity diagnostic](../../../../frontends/dsh/benchmarks/README.md) measures three tiers with compiled Host and worker artifacts; it excludes installed-platform and real-model acceptance.
