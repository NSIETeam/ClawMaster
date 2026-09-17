# Agent Note: Durable WatchDog dispatch without cold Session adoption

Status: implemented

English | [中文](2026-09-16-watchdog-persistent-dispatch.zh.md)

## Problem

Session-local reminders cannot report a stopped Host independently of the executing conversation or coordinate competing product workers. A crash between enqueue and acknowledgement also leaves an execution ambiguity that automatic retry cannot safely resolve for arbitrary agent side effects.

## Decision

The [WatchDog scheduling owner](../../../../frontends/dsh/scheduling/README.md) persists immutable plans, bounded occurrence materialization, single-use grants, fenced leases and independent worker heartbeats in an organization-bound SQLite ledger. DSH Schedule retains timing validation and fixed-rate arithmetic; DSH Jobs retains producer ownership and cancellation. Delivery only uses an existing live root and the public durable inbox. No Session scan, implicit resume, background-service installation or credential transfer occurs.

Each occurrence requires explicit approval. Conversation tools use DSH's turn-enclosed approval service; authenticated human commands persist the exact occurrence grant. Enterprise dispatch rechecks the initiating member, delegated resource permissions and an independent approval before enqueue. The stored occurrence id binds the authorization and model-visible input. Read-only plan, occurrence and history pages admit complete records against the final HTTP or DSH envelope byte budget. Independent worker cursors and whole-ledger status counts preserve observability when individual heartbeat rows occupy later pages.

Busy Session admission preserves the failed-attempt budget and the existing deadline. DSH maintenance claims are synchronous; a public idle status alone cannot exclude another maintenance task. Enterprise approval consumption has its own durable pre-dispatch marker because the authority and occurrence ledger cannot commit atomically. Any interrupted marked claim requires fresh approval, including after lease recovery; an automatic retry cannot assume the old grant remains unused.

A durable barrier precedes enqueue. Missing confirmation after that point remains uncertain and requires an audited human acknowledgement or cancellation without replay. The protocol favors preventing an automatic duplicate over pretending that a cross-store SQLite/Session transaction is atomic. Dispatch completion records input durability; business review remains a separate owner.

The management panel binds each successful receipt to its command id. Unconfirmed requests retain their full payload across panel navigation, preventing a second command from silently replacing the first. Human uncertainty resolution requires a Session inspection acknowledgement and reason; neither panel rendering nor worker observation grants execution. Input validation failures remain editable while missing or unrelated receipts remain unresolved.

An active plan with no online worker raises an in-app alert after a status read. The Home health view also reports ledger-wide counts of failed and uncertain occurrences, including instances outside the visible plan page. While the schedule panel is mounted and the app is visible and online, the panel refreshes every 30 seconds and on window focus or network recovery. Automatic observations preserve page cursors and loaded history, update selected occurrences, and defer while a read or unresolved write is active. These reads do not refresh worker heartbeats or drive recovery; they cannot notify an operator while the app or host is offline.

## Alternatives considered

Extending the core Schedule runtime to wake cold Sessions violates its live-root ownership rules. Replacing Jobs would duplicate cancellation and teardown. Automatically retrying an ambiguous enqueue risks duplicate external effects; interpreting a healthy worker or completed dispatch as business success hides failures. Independent database copies cannot provide a distributed lease and are outside this deployment model.

## Consequences

Schema 2 requires every worker stopped before upgrade. Fresh unstopped heartbeats block migration; existing audit rows and command receipts are retained. Old leased claims require approval recovery because schema 1 cannot distinguish an unspent grant from a consumed grant before enqueue. Existing connections cannot be revoked by a SQLite version bump, so operators must stop old workers rather than perform a rolling upgrade.

Workers sharing one local database agree on organization and deployment limits. Missing approval, offline roots, exhausted admission and expired leases have explicit bounded outcomes. Arbitrary model effects still require their own idempotency and approvals. Installed desktop sleep/resume, server operation and external delivery require separate acceptance evidence; synthetic-model and temporary-process tests do not establish those results.

## Verification

The [store tests](../../../../frontends/dsh/tests/watchdog-schedule.test.mjs) exercise bounded missed work, DST validation, command receipts, isolated organization state, expiry, lease fencing, rolling admission and a real two-process crash after a single recorded side effect. The [Host replay](../../../../frontends/dsh/tests/watchdog-schedule-host.scenario.mjs) mounts production AgentLoop, Jobs, approval and JSONL persistence to verify one durable dispatch, missing approval, delegated revocation during persistence, uncertainty and cancellation. The [management-panel tests](../../../../frontends/dsh/tests/schedule-board.client.spec.mjs) verify the no-worker alert appears for an active plan and clears when a live heartbeat returns, failed and uncertain ledger counts reach the Home health view, and connectivity recovery triggers a status read. The Host replay's owner-local fixture fixes scheduled model input independently of the wall clock.
