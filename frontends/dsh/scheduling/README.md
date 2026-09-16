---
description: "Durable WatchDog prompt plans, per-occurrence approval, worker recovery and authenticated observation."
kind: "package-reference"
---

# WatchDog persistent scheduling

English | [中文](README.zh.md)

## Summary

WatchDog stores product plans, occurrences, grants, worker leases and history in `schedules.sqlite` beside the enterprise database. It uses official DSH Schedule validation and fixed-rate calculations, DSH Jobs for cancellation and lifecycle ownership, and the live agent's durable inbox for delivery. The original Session-local Schedule reminders remain separate. Creating a product plan does not grant future execution.

## Contents

- [Execution and approval](#execution-and-approval)
- [Recovery](#recovery)
- [Authenticated interfaces](#authenticated-interfaces)
- [Deployment settings](#deployment-settings)
- [Verification limits](#verification-limits)

<a id="execution-and-approval"></a>
## Execution and approval

In WatchDog management, open Scheduled checks and choose Create check plan. Select an existing execution Session, describe the goal and scope, then choose a fixed interval or a future time and timezone. Creating a plan sends no model prompt. Select the saved plan to inspect its occurrences and approve a specific delivery. Stop future checks leaves existing occurrences intact; cancel those separately when needed. Worker counts and heartbeat pages are observations at the displayed read time; refresh to obtain current state.

The panel keeps one page per collection and retains the exact unconfirmed command across panel navigation. A lost response locks further writes until retry confirms the original command receipt. Reloading or quitting clears this in-memory retry; inspect persisted plans and history before issuing a replacement. Invalid dates, timezones and explicit refusals leave the form editable. Uncertain delivery requires inspecting the original Session, checking the confirmation box and entering a reason before human resolution.

Every occurrence starts in `waiting_approval`. An authenticated human can approve that exact occurrence through the command endpoint. An agent can request the same grant through `watchdog_schedule_command`; DSH must return `allowed-once` inside an open conversation turn. Missing answerers, disabled approvals, unavailable governance services and expired grants never authorize execution. Approval expires at `createdAt + approvalTimeoutMs`, including any time spent waiting for the bound Session or retrying delivery. Creating a plan, recovering a worker and reopening the desktop do not approve occurrences.

Delivery rechecks the current bound Session's task-write resource permission and initiating member. Enterprise mode also checks current delegation and consumes an independent, object-bound approval through the configured governance authority. Its command id is the occurrence id, generation and revision are zero, and the digest covers the immutable plan id, occurrence id, scheduled time and prompt. Revoked membership or a different Session owner blocks dispatch. This occurrence grant authorizes the prompt only; tool-specific DSH and enterprise approvals still apply during execution.

The Host dispatches only to an already live root agent belonging to the plan's Session. It never resumes a cold Session, transfers credentials or creates an operating-system service. `desktop` and `server` describe the explicitly configured Host deployment: desktop work stops when the application stops; server work requires an operator-managed, running DSH Host and live bound root. A powered-off or sleeping host executes nothing. Distinct machines with separate database copies are not coordinated workers; use one authorized server and its local ledger for shared execution.

`dispatched` confirms that the identified prompt reached the Session persistence barrier. It does not mean the model succeeded, a business task passed review, or a message reached an external system. Inspect the Session and the business task's evidence separately. The scheduler sends no external notifications and does not cancel an already dispatched conversation turn.

<a id="recovery"></a>
## Recovery

Each occurrence has a unique `(planId, scheduledAt)` identity. SQLite serializes claims and records the lease owner, expiration, attempt count and fencing generation. Workers must share one local ledger and identical persisted limits. Expired pre-dispatch claims can retry with bounded exponential backoff. The irreversible dispatch barrier is persisted before enqueue; a crash or unconfirmed persistence after that barrier becomes `uncertain` and is never automatically replayed. This prevents automatic duplicate dispatch after an ambiguous crash; it is not an exactly-once guarantee for arbitrary model-generated side effects.

A busy turn or maintenance task defers admission without spending a failed execution attempt; the original approval deadline still applies. Before enterprise approval consumption, the worker durably marks the claim. Interruption, cancellation or lease loss before the dispatch barrier returns that occurrence to `waiting_approval` with `approval_required_after_interrupted_admission` and clears its prior approver. Recovery requires a fresh authority grant and a new explicit `approve` command; neither extends the deadline. The worker always checks current permissions again.

Ledger schema 2 adds interrupted-approval recovery. Stop **all** workers before upgrading schema 1; migration refuses any fresh heartbeat not marked stopped, preserves plans, command receipts and prior audit rows, and treats old leased claims as potentially consumed approvals. Claims beyond the dispatch barrier still become uncertain. This is an offline upgrade: the heartbeat check cannot prevent an old process with an already open connection from resuming, so mixed-version or rolling worker upgrades are unsupported.

An authenticated human resolves `uncertain` by inspecting the occurrence id in the original Session, then submitting `resolve-uncertain` with `acknowledge-dispatched` or `cancel` and a reason. Both preserve an append-only audit entry. Neither resolution re-enqueues the prompt or undoes an external effect. An agent cannot resolve uncertainty. `cancel-plan` stops future occurrence materialization; `cancel-instance` separately fences an occurrence that has not crossed the dispatch barrier.

Missed-time strategies are `skip`, `coalesce` and `catch-up`. Skip admits only the latest occurrence within `onTimeGraceMs`; coalesce admits the latest due occurrence; catch-up admits at most the configured latest occurrences. Per-plan pending capacity bounds repeated catch-up polls, and discarded occurrences accumulate in `missedCount`. Fixed-rate anchors remain UTC-based across local daylight-saving changes; one-shot local times use DSH's explicit timezone and ambiguity validation. A backward clock does not rewind the persisted cursor.

Database-wide active leases and a rolling dispatch-count budget bound admission across processes. The budget counts attempts that entered the dispatch barrier, including uncertain attempts; it is not a monetary or model-token quota. Offline Sessions and pre-enqueue failures have finite retry attempts. Expired approval, exhausted retries and uncertainty are durable queryable outcomes. Heartbeats report `online`, `degraded`, `offline` or `stopped`; an independent observer can read stale heartbeat and expired-lease facts without a live agent or an executing scheduler. Heartbeat status does not prove model or business success.

<a id="authenticated-interfaces"></a>
## Authenticated interfaces

All paths use the existing authenticated DSH Fetch carrier and the same governance `task.read` / `task.write` resource checks as business tasks. A specific plan uses its id as the resource; listing all plans requires `*`. Cross-organization callers are rejected. Query results have configurable byte limits and pages of at most 100 records. Tool limits count the complete DSH value and rendered-text envelope, including JSON escaping. Pages shorten to retain complete records within that carrier budget; `nextAfter` identifies the last included row, without skipping the next record. A first whole record together with its worker observation that cannot fit fails explicitly with `response_too_large` rather than returning an empty continuation. A command whose receipt exceeds its carrier budget rolls back before commit. Unknown or repeated query fields and non-boolean history selectors are rejected.

| Interface | Input and result |
| --- | --- |
| `GET /api/clawmaster/schedules` | Plan page, actual deployment mode and independent worker status. |
| `GET /api/clawmaster/schedules?id=PLAN` | Occurrence page including scheduled time, approval deadline, lease, attempts, reason and completion time. |
| `GET /api/clawmaster/schedules?id=PLAN&history=true` | Append-only decisions and actor records. |
| `after` / `limit` | Continue with the response's `nextAfter` cursor; the byte budget can return fewer than `limit` complete records. |
| `workersAfter` | Independently continue the worker list using `workerSummary.nextAfter`; history queries require this cursor to be zero. |
| `workerSummary` | Counts every worker as `online`, `degraded`, `offline` or `stopped`, including workers on later pages; `total` and `nextAfter` make partial lists explicit. |
| `POST /api/clawmaster/schedules/command` | JSON `{commandId,command}` from a human; exact retries return their stored receipt. |
| `watchdog_schedule_query` | The same bounded read fields for an authorized agent. |
| `watchdog_schedule_command` | A `request` string containing the command JSON; every command needs one-shot DSH approval. |

Observation uses stable row cursors and does not refresh heartbeats, recover leases, prune workers or append audit entries. Worker pages contain at most 100 complete records and share the carrier byte budget with the requested plan or occurrence page. History pages contain no worker observation.

Commands are immutable definitions or state transitions. `create` takes `id`, `sessionId`, `prompt`, `rule`, `missed` and `catchUpLimit`. A rule is `{kind:"every",everySeconds:300}` or `{kind:"at",at:"2026-12-01T09:00:00+08:00"}`; `at` also accepts DSH's `{date,time,time_zone}` input. `approve` takes the plan `id` and `instanceId`; cancellation additionally takes `reason`; `resolve-uncertain` additionally takes `resolution` and `reason`. Command ids cannot be reused with another actor or payload. No command accepts an identity, organization, permission or approval receipt from model-supplied JSON.

<a id="deployment-settings"></a>
## Deployment settings

The Host accepts `scheduleDatabasePath` and `watchdogSchedules`. An omitted database path uses `schedules.sqlite` in the configured enterprise database directory. Limits are validated at load and stored with the organization binding; a worker with different limits fails to open the ledger. Changing persisted limits requires an explicit reviewed migration, rather than an implicit reinterpretation on restart.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `desktop` | `desktop` or explicitly operated `server`; installs no daemon. |
| `busyTimeoutMs` | 5000 | Maximum SQLite lock wait per operation. |
| `pollMs` / `leaseMs` | 1000 / 30000 | Wall-clock sampling and maximum dispatch claim duration. |
| `heartbeatStaleMs` | 15000 | Offline threshold for independent readers. |
| `maxPlans` / `maxMaterializePlans` | 1000 / 64 | Lifetime plan capacity and due plans examined per poll. |
| `maxPendingPerPlan` | 10 | Total outstanding occurrences retained per plan. |
| `maxConcurrent` | 2 | Active dispatch leases across workers. |
| `maxDispatchesPerWindow` / `budgetWindowMs` | 10 / 3600000 | Rolling dispatch-attempt admission budget. |
| `approvalTimeoutMs` | 3600000 | Approval and delivery deadline from materialization. |
| `retryBaseMs` / `retryMaxMs` / `maxAttempts` | 1000 / 60000 / 5 | Pre-barrier backoff and finite attempt limit. |
| `onTimeGraceMs` | 5000 | Latest-occurrence lateness accepted by skip. |
| `maxQueryBytes` | 262144 | Maximum serialized HTTP or tool result bytes. |

<a id="verification-limits"></a>
## Verification limits

The owner-local tests exercise real SQLite workers, crash recovery, the production DSH Jobs provider, AgentLoop and JSONL persistence, missing approval, revocation, bounded replay, stale-heartbeat observation and a fixed model-input snapshot. Rendered panel tests use the registered Host and SQLite for approval, cancellation, uncertain resolution and response-loss retry; compiled client expectations include the management entry. Tests use temporary state and a synthetic model. They do not validate installed desktop sleep/resume, server service management, actual provider charges, external delivery, multi-host network filesystems or authorized credential migration. Session-local reminder controls remain separate from these product plans.
