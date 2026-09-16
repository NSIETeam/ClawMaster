# Agent Note: Enterprise reviewed writes and bounded queries

Status: implemented

English | [中文](2026-09-13-enterprise-reviewed-writes-and-bounded-queries.zh.md)

## Problem

WatchDog inspection must not change business records without a user decision. DSH file permissions govern filesystem operations, while the enterprise tools write SQLite directly. Treating contact and order-draft writes as low risk leaves those records writable without approval, including from delegated Sessions.

A form can also retain old values while another component refreshes the shared database revision. Attaching that new revision to an old draft bypasses the user's review. Separately, limiting model output does not limit internal allocation when each query or command first constructs a snapshot containing every collection and audit entry.

## Decision

The [enterprise tools](../../../../frontends/dsh/src/enterprise-tools.ts) request the existing DSH approval service for every new mutation and require `allowed-once`. An owning agent is required; `never`, rejection, cancellation or unavailable approval leaves records unchanged. An exact committed command replay performs no mutation and needs no additional approval. Authenticated manual HTTP saves remain user-initiated operations. This extends the enterprise behavior owned by the [ClawMaster shell](../feature/2026-09-12-clawmaster-shell-over-dsh.md) without introducing another policy engine.

[CRM and ERP forms](../../../../frontends/dsh/src/BusinessModules.tsx) retain the editing revision separately from shared refreshed records. A changed revision blocks saving and presents current values alongside the retained draft. Explicit review accepts saving that whole draft against the displayed revision; it does not merge fields. Deleted records and submitted orders cannot resume editing. Deletion and submission confirmations expire on revision changes. The client passes the reviewed revision explicitly and retains uncertain writes under their original command identity.

The [store](../../../../frontends/dsh/src/enterprise-host.ts) owns collection filtering, counting and pagination in SQLite. SQL identifiers come from a fixed collection map; user filters and offsets are bound values. A connection-local Unicode lowercase predicate preserves literal text search, including punctuation. Iteration admits records within the result byte budget, and an oversized single record fails explicitly. Pagination carries both database versions and refuses changes between pages. The [manual pagination decision](2026-09-16-enterprise-paged-workspace.md) owns the shared browser protocol and iterated startup validation.

A Host-owned command budget is shared by record, task and schedule HTTP/tool consumers. HTTP commands use streaming routes so the image-sized carrier buffer does not allocate their bodies before admission. Identity resolves before JSON reading; actual bytes, including chunked UTF-8 input, remain bounded. An upload deadline covers identity resolution and body reads, while concurrency remains reserved through approval and commit. Consumers release their body reader on cancellation; the carrier closes the unread request after delivering the refusal. Tool argument bytes are checked after DSH decoding and before domain parsing or approval. Capacity and timeout responses preserve the client command identifier for exact retry. The [frontend configuration](../../../../frontends/dsh/README.md#understand-the-implementation) owns deployment limits.

Approval preparation reads the target record, any stock referenced by submission, or an existing receipt. AI commits return one durable receipt through the same transaction owner as manual saves. Revision comparison, command identity, business effects, audit insertion and revision increment remain atomic. Exact replay returns the stored receipt with the current revision; conflicting command reuse fails. Schema 2 adds a database-local restore generation. Backup restoration imports records and receipts atomically but increments that generation rather than importing it. Commands check the captured generation before receipt lookup and revision comparison, including after approval. Queries return and fence the generation together with revision; legacy requests belong to generation zero. Forms capture both values and require explicit review after either changes. This prevents old requests from becoming valid when a restore repeats a revision.

## Alternatives considered

**File sandbox or prompt-only restrictions.** Neither enforces permission for direct SQLite mutations. The existing DSH approval service already owns user decisions and delegated `never` policy.

**Automatically advance a draft to the refreshed revision.** The user has not reviewed the newer record. Explicit review preserves input while making the overwrite decision visible.

**Build a complete snapshot, then trim output.** A small contact query still materializes unrelated audit history. Targeted queries remove that allocation.

**Omit startup validation.** Removing open-time validation weakens detection of invalid durable data. Iteration preserves semantic checks without retaining every record.

## Consequences

AI inspection remains read-only until a new mutation receives approval. Human saves retain their authentication and transaction behavior. Search can scan the selected collection to count matches; private backup executors own complete validation and bounded file transfers. The [frontend limitations](../../../../frontends/dsh/README.md#known-limitations-and-deferred-work) do not promise unrestricted large-database capacity.

The [tool tests](../../../../frontends/dsh/tests/enterprise-tools.test.mjs) exercise real ToolRuntime and ApprovalService denial, single-use approval and replay. SQL access tracing rejects unrelated collection reads against 2,000 synthetic audit entries and covers literal search, byte limits and stale pagination. [Store tests](../../../../frontends/dsh/tests/enterprise-host.test.mjs) preserve rollback, revision checks and replay after reopen; [client tests](../../../../frontends/dsh/tests/enterprise-client.test.mjs) reject stale commands. The [compiled component tests](../../../../frontends/dsh/tests/components-native.client.spec.mjs) preserve old input until review, and the [recorded business flow](../../../../frontends/dsh/tests/business-tool-flow.test.mjs) includes the approval outcome without real model use.
