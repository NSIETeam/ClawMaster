# EasyCode Reference Audit

> Audited: 2026-09-05
> Source: `OrionStarAI/EasyCode`, branch `opensource`, commit `887b8bb4`
> License: Apache-2.0

## Purpose

EasyCode is used as a design reference only. ClawMaster keeps ownership of its
runtime, protocol, desktop shell, security policy and release matrix. No
EasyCode package or Node.js runtime is added to the desktop distribution.

## Decisions

| EasyCode capability | ClawMaster decision | Evidence |
| --- | --- | --- |
| Goal watchdog and completion judge | Already present; keep ClawMaster's fail-closed independent evaluation. | `packages/core/src/tools/goal-achieved.ts`, `packages/core/src/agents/runGoalEvaluation.ts` |
| Background task manager | Already present; keep ClawMaster's overlapping-worktree conflict guard and listener-safe unsubscribe behavior. | `packages/core/src/services/backgroundTaskManager.ts` |
| Local external-Agent detection | Adopt the concept with a stricter launch-chain probe and runtime recheck. | `packages/core/src/acp-client/localAgentDetection.ts`, `packages/core/src/tools/delegate-agent.ts` |
| Skill script executor | Reject. It depends on Python/Bash/Node, builds shell command strings from arguments, and its upstream tests are skipped. | ClawMaster Skills remain behind existing tool, policy and confirmation paths. |
| Default `im:message.send_as_user` exclusion | Reject as written. Excluding a scope outside the requested Lark domain can make domain login fail. | `packages/core/src/tools/lark-cli.ts` and its domain-login regression tests |
| Electron updater, Mermaid and desktop theme changes | Do not port. ClawMaster uses Tauri/Rust and already owns its renderer workspace. | `packages/desktop/src-tauri`, release gates |

## Adopted External-Agent Contract

1. Default delegation is exposed only when both the ACP bridge launcher and
   selected local Agent executable are available.
2. A configured `CLAWMASTER_*_ACP_CMD` bridge is accepted only when its
   executable can be resolved.
3. Availability is checked again immediately before dispatch.
4. Failed detection returns `dispatched: false`, creates no background task,
   and tells the model to continue locally when possible.
5. Detection failures never crash startup and add no runtime dependency.

## Verification

```bash
npx vitest run \
  src/acp-client/localAgentDetection.test.ts \
  src/config/external-agent-registration.test.ts \
  src/tools/delegate-agent.test.ts
```

The focused suite contains 35 tests. Core typecheck, lint, repository doctor
and code-map checks are also required before merge.
