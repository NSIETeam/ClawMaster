# Agent Note: WatchDog StateCapsule follows durable task history

Status: implemented

English | [中文](2026-09-18-watchdog-state-capsule.zh.md)

## Problem

Restart recovery needs an owned record that combines task context with the state needed to resume safely. Session logs preserve model-visible events, while task revisions own the business target, approval status and evidence.

## Decision

StateCapsules are stored in the existing WatchDog task row and immutable task history. Each record contains decisions, file hashes, verification results, unfinished actions and memory IDs; target and approval state are derived from the task and refreshed on every task revision. User records are keyed to the authenticated principal. Session records require a task-linked Session, and project records require a registered Workspace containing a task-linked Session. Read and command responses filter by owner and recheck the relevant Session or Workspace association.

The capsule schema contains no credential fields, and no credential export path is added. Existing task rows load with an empty capsule list. Capsule mutations through the agent tool remain subject to the existing one-shot approval flow and task revision checks. Authenticated principal identifiers use the same opaque 1-to-128 UTF-16-code-unit Unicode rule in provider responses, task member owners, submitter fields, capsule ownership and durable responsibility identities; this permits email identities without loosening who may establish an identity. The validator is shared, so owner fields cannot drift back to a narrower character set.

## Consequences

Recovery reads the task's current revision and history, so it does not create an independent store or claim Session state that was never logged. Workspace membership is established through task-linked Sessions, while per-principal ownership prevents another member of the same organization from reading a capsule. Stored free text is not scanned for secrets; callers must not place credentials in notes, decisions, rationales or summaries.

The focused regression test covers restart persistence, task approval-state refresh, cross-principal filtering, Session and Workspace scope checks, unknown credential fields, and existing DSH tool behavior.

## Alternatives considered

**Create a separate capsule database.** The existing task row and immutable history already own task context and revisions. A second store would require cross-store ordering and recovery rules without establishing a stronger authority.

**Copy all task and Workspace details into each capsule.** Those facts change independently and could become stale. The implementation derives target, approval, Session and Workspace association from the current authoritative records each time.
