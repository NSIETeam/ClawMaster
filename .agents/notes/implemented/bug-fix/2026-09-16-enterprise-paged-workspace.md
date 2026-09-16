# Agent Note: Enterprise pages preserve reviewed versions without whole-store responses

Status: implemented

English | [中文](2026-09-16-enterprise-paged-workspace.zh.md)

## Problem

Small manual reads and saves can allocate every business record and audit entry when the browser protocol uses complete snapshots. Merely slicing a table in the browser leaves transport and Host memory proportional to accumulated history. A partial list also cannot establish that an edited record was deleted or that every selectable inventory item has been loaded.

## Decision

The [shared enterprise store](../../../../frontends/dsh/src/enterprise-host.ts) returns separate version/count metadata, collection pages and durable command receipts. Both model and browser continuations carry generation and revision; the Host refuses changed datasets. Filters apply before stable SQL ordering and pagination. An unfiltered audit page uses a revision range instead of discarding every earlier row. Text search reads columns and referenced item identifiers; literal business JSON field names are not search terms. Authorization applies to the selected collection and record, while global counts require broad record and audit access.

The [client](../../../../frontends/dsh/src/enterprise-client.ts) retains one page per visible list. Editors retain their own reviewed versions, read their current record by ID and require explicit review after either version changes. Inventory selection searches a bounded candidate page and resolves selected IDs separately. Missing records in a list do not mean deletion. A validated write receipt establishes success independently of the subsequent read; uncertain mutation responses retain the exact request identity. Known authorization denial settles a request without retrying it. Abandoned page reads cannot replace later errors or data.

Browser row/byte limits are configured through the frontend Host. The transaction refuses a new change whose complete audit entry cannot fit a one-record page, rolling back business effects, revision and success history. Existing oversized records remain intact and fail with a recoverable byte-limit error. Startup iterates all records and responsibility history, validates domain facts, audit continuity and references, and retains uniqueness checks without loading a complete snapshot. Index creation and semantic validation remain inside the atomic database migration transaction.

The [reviewed-write decision](2026-09-13-enterprise-reviewed-writes-and-bounded-queries.md) still owns one-shot model approvals and exact replay. This decision changes the pre-stable browser HTTP responses and updates the client and desktop startup/restart smoke together. Portable backup format 1 is unchanged; pagination indexes do not replace stored records. A Host and browser bundle must be deployed together because the overview/receipt protocol does not support old snapshot consumers.

## Alternatives considered

**Fetch every page before rendering.** This bounds each request but retains whole-store browser allocation and delays interaction until unrelated collections load.

**Advance a continuation after a concurrent edit.** Insertion, deletion and sorting changes can mix revisions or omit records. Requiring a refresh preserves an explicit reviewed dataset.

**Skip startup validation or trim oversized records.** Both conceal invalid or incomplete durable data. Iteration bounds retained objects while checking every record; explicit size failure preserves stored content.

## Consequences

Ordinary list and save responses are independent of total audit history. The [capacity report](../../../../frontends/dsh/benchmarks/README.md) records three synthetic tiers through production HTTP handlers, including actual serialization, with source and worker provenance. Search/count time and startup validation still grow with data size. Explicit file operations follow the [backup-worker decision](2026-09-16-enterprise-backup-workers.md). Process-tree budgets and installed-platform acceptance remain separate concerns.

[Route regressions](../../../../frontends/dsh/tests/enterprise-pagination.test.mjs) cover stale pages, restores, Unicode bytes, oversized writes, semantic startup refusal and cancelled requests. [Client and rendered-page tests](../../../../frontends/dsh/tests/enterprise-restore.client.spec.tsx) cover cross-page review, inventory selection, history navigation and read-failure recovery. The [recorded model scenario](../../../../frontends/dsh/tests/business-tool-flow.scenario.mjs) reconstructs pagination and its rejected continuations from Session JSONL.
