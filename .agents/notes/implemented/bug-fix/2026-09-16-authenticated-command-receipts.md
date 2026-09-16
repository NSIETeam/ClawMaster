# Agent Note: Command receipts retain authenticated ownership

Status: implemented

English | [中文](2026-09-16-authenticated-command-receipts.zh.md)

## Problem

A command identifier proves which operation was requested, not who requested it. Returning another caller's receipt can falsely attribute success and omit approval even when no second mutation occurs. Human member identifiers and agent Session identifiers occupy different namespaces; agent ownership also depends on its initiating member.

## Decision

Business and task receipts bind organization, actor kind, actor ID, initiating principal and the SHA-256 of the complete validated command envelope. Authorization still checks current membership before replay. Policy versions, transport, call IDs and approval records are excluded from the stable identity: changing those facts does not transfer ownership, and a legitimate retry can have a new call ID. Both preparation and commit check the binding; a new binding commits in the same SQLite transaction as its mutation and responsibility record. Restore receipts include the initiating principal in their request hash.

The schema 5 migration creates an independent receipt-ownership table without inferring actors from old business history. Unknown maintenance writes and unowned legacy receipts remain readable but cannot authorize replay. Business backups carry record/audit data, not authenticated receipt ownership. Restoring data does not delete existing ownership; the complete request's generation prevents old command IDs from acquiring a new meaning after restore. A conflicting or unowned receipt returns `command_conflict`; callers must inspect current state and explicitly review a new command before submitting another identifier.

The [task identity decision](../architecture/2026-09-16-watchdog-task-identity.md) continues to own role checks and independent approval. The [responsibility history decision](../architecture/2026-09-16-enterprise-responsibility-history.md) continues to own attribution of historical actions.

## Alternatives considered

**Matching the command body alone.** Another member can know the same body and identifier; content equality does not establish identity.

**Backfilling old receipts with the current operator.** The current operator need not be the original actor. Denying ambiguous replay preserves historical truth and avoids repeating an uncertain mutation.

**Requiring the same policy version or approval ID on retry.** Current authorization must be checked again, but a completed command already consumed its approval. Binding changing authorization metadata would unnecessarily prevent recovery after a lost response.

## Consequences

HTTP and real DSH ToolRuntime regressions cover member changes, human/agent ID collisions, reassigned agent principals, changed revisions and same-owner retry across database reopening. A vulnerable-baseline negative control verifies the tests fail on unauthorized receipt reuse. Migration and restore checks preserve existing records while rejecting missing ownership. A real Loader/AgentLoop scenario records both model-visible denials and reconstructs them from persisted JSONL. These checks establish local authorization behavior, not a deployed identity provider or multi-user runtime isolation.
