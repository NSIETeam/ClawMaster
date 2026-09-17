# Agent Note: ClawMaster runtime governance

Status: implemented

English | [中文](2026-09-13-clawmaster-runtime-governance.zh.md)

## Problem

An installed runtime changes independently of remembered paths and versions. A payload digest proves byte identity but does not prove which source produced JavaScript. Desktop defaults also need controlled writes and bounded work without maintaining a second DSH execution engine.

## Decision

The [shell decision](../feature/2026-09-12-clawmaster-shell-over-dsh.md) retains ownership of bundle provenance and Workspace preservation. This note owns live observations and execution governance; neither replaces historical Session data or OpenViking memory.

The native shell publishes a private runtime identity after Host readiness. The live Host reads it afresh, requires its own PID, and exposes timestamped facts through `runtime_status` and DSH's durable runtime-context assembly. Normal teardown marks only its own generation stopped. Missing, stopped or mismatched records return unavailable; remembered values never serve as fallback. A raw file is a dated observation, not an independent liveness probe after a crash. Source-development and WSL launches do not claim this native identity. The [desktop README](../../../../apps/desktop-tauri/README.md) owns the record's location and lifecycle.

The Host projects the shell's bounded component inventory as names, versions, manifest digests and aggregate artifact digests, and projects local patch basenames and digests. It does not return inventory paths. Older records without inventory return `null`; invalid or oversized inventory makes the observation unavailable. Each observation carries its own as-of time.

The frontend contributes RSS admission through DSH's monotonic tool guard and limits overlapping heavy tool bodies through its execution waterfall. It reserves capacity before delegation and releases it after the body settles. Rejection leaves diagnostics available and does not kill active work or other applications. Configurable limits and their scope live in the [frontend README](../../../../frontends/dsh/README.md#model-experience).

The ClawMaster profile selects DSH's controlled file preset and ordinary approvals. Child Sessions retain their original delegation events, while canonical DSH setters append narrower permissions before a model step or tool when current ancestors grant less. Missing ancestry fails to read-only; child approvals remain unavailable. This product restriction preserves DSH's historical delegation snapshot rather than rewriting released Session records. Cold-resume tests cover actual filesystem denial and persisted narrowing. The frontend README owns configurable defaults and their precedence.

The [destructive-action guard](../../../../frontends/guard/README.md) normalizes explicit Windows drive and UNC paths independently of the host running its tests. Protected-prefix matching covers literal and resolved paths; POSIX case and backslashes remain literal. Its deny decision enters the ordinary ToolRuntime result and survives JSONL replay without executing the shell body.

## Alternatives considered

**Store current paths in long-term memory.** A remembered observation cannot establish that a process is still running or that an upgrade has selected another generation.

**Ship Git metadata in the runtime.** Commit and source records establish provenance without carrying repository history, configuration or credentials into application resources.

**Kill processes when free memory is low.** A free-memory snapshot does not identify reclaimable memory or which application's work can be interrupted safely. Admission and bounded overlap protect the owned work without making a machine-wide guarantee.

## Consequences

Runtime observations enter the Session log through the existing context and tool-result paths. Keyless AgentLoop recording compares replayed messages with the actual model input; native state tests and tool dispatch tests reject stale identity, malformed records, RSS excess and concurrent admission. Empty unregistered generation directories do not consume rollback retention slots; registered Workspace directories remain protected. Resource budgets cover Host RSS and overlapping selected tool bodies, not detached processes, background work after return, native editors or other applications.
