# Agent Note: Durable WatchDog dispatch without cold Session adoption

Status: implemented

English | [中文](2026-09-16-watchdog-persistent-dispatch.zh.md)

## Problem

Session-local reminders cannot report a stopped Host independently of the executing conversation or coordinate competing product workers. A crash between enqueue and acknowledgement also leaves an execution ambiguity that automatic retry cannot safely resolve for arbitrary agent side effects.

## Decision

The [WatchDog scheduling owner](../../../../frontends/dsh/scheduling/README.md) persists immutable plans, bounded occurrence materialization, single-use grants, fenced leases and independent worker heartbeats in an organization-bound SQLite ledger. DSH Schedule retains timing validation and fixed-rate arithmetic; DSH Jobs retains producer ownership and cancellation. Delivery only uses an existing live root and the public durable inbox. No Session scan, implicit resume, background-service installation or credential transfer occurs.

Each occurrence requires explicit approval. Conversation tools use DSH's turn-enclosed approval service; authenticated human commands persist the exact occurrence grant. Enterprise dispatch rechecks the initiating member, delegated resource permissions and an independent approval before enqueue. The stored occurrence id binds the authorization and model-visible input.

A durable barrier precedes enqueue. Missing confirmation after that point remains uncertain and requires an audited human acknowledgement or cancellation without replay. The protocol favors preventing an automatic duplicate over pretending that a cross-store SQLite/Session transaction is atomic. Dispatch completion records input durability; business review remains a separate owner.

## Alternatives considered

Extending the core Schedule runtime to wake cold Sessions violates its live-root ownership rules. Replacing Jobs would duplicate cancellation and teardown. Automatically retrying an ambiguous enqueue risks duplicate external effects; interpreting a healthy worker or completed dispatch as business success hides failures. Independent database copies cannot provide a distributed lease and are outside this deployment model.

## Consequences

Workers sharing one local database agree on organization and deployment limits. Missing approval, offline roots, exhausted admission and expired leases have explicit bounded outcomes. Arbitrary model effects still require their own idempotency and approvals. Installed desktop sleep/resume, server operation and external delivery require separate acceptance evidence; synthetic-model and temporary-process tests do not establish those results.

## Verification

The [store tests](../../../../frontends/dsh/tests/watchdog-schedule.test.mjs) exercise bounded missed work, DST validation, command receipts, isolated organization state, expiry, lease fencing, rolling admission and a real two-process crash after a single recorded side effect. The [Host replay](../../../../frontends/dsh/tests/watchdog-schedule-host.scenario.mjs) mounts production AgentLoop, Jobs, approval and JSONL persistence to verify one durable dispatch, missing approval, delegated revocation during persistence, uncertainty and cancellation. Its owner-local fixture fixes the scheduled model input independently of the wall clock.
