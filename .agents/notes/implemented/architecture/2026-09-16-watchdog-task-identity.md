# Agent Note: Business tasks use trusted caller identity

Status: implemented

English | [中文](2026-09-16-watchdog-task-identity.zh.md)

## Problem

Agent activity cannot represent business acceptance, and a desktop Host token does not identify an organization member. Task acceptance and record mutations need an independent business state and current authorization.

## Decision

The WatchDog frontend owns durable tasks, revisioned commands, immutable submission/review history and HTTP/tool consumers. DSH Sessions remain the execution owner. Importing an existing Session creates a draft with an explicit source; no idle or stopped Session implies completion. Agents may submit evidence, while human-only transitions perform review, cancellation and reopening. Organization submitters cannot approve their own results.

One GovernanceAccess instance resolves caller identity through a trusted authority and checks roles/resources on every operation, including after asynchronous approvals. The authority binds agent Sessions server-side; delegation intersects current initiator and delegate permissions. Record writes, task writes and restores consume a one-shot approval bound to command, resource, generation, revision and digest. DSH tool approval does not substitute for enterprise approval. Human task review directly requires the review role. Exact committed task retries check current access without another approval. Complete snapshots require record and audit read access across the organization; enterprise writes expose only receipt metadata. A database retains its organization binding across business restore. Local operators remain explicitly local and existing data never uploads or changes organization automatically. [Responsibility history](2026-09-16-enterprise-responsibility-history.md) records trusted actor and policy facts separately from restored business history.

## Alternatives considered

**Deriving business state from Session activity.** A stopped Session can mean pending review, failure or cancellation; those outcomes require an explicit task command.

**Accepting member IDs from request JSON or a desktop access token.** Neither proves an organization identity. Enterprise configuration requires an independently authenticated provider and fails closed when it is missing or unavailable.

**Keeping permissions only at page rendering.** An open page or queued tool could retain revoked permissions. Both carriers check current membership at execution.

## Consequences

Local task and audit APIs work without an identity provider. Enterprise consumers expose an integration interface, not a bundled login system or proof of a deployed multi-user service. Attachment serving, local-to-enterprise migration and the real desktop business workflow remain integration work. Tests exercise the real DSH tool schema/approval/output pipeline, cross-organization rejection, permission revocation during an approval wait, delegation, database organization binding, stale commands and retained resubmission evidence. Recorded-session snapshots and desktop UI acceptance remain required before closing the product Issues.
