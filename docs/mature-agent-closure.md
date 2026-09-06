# Mature Agent Closure Plan

Otto is only considered a mature agent platform when the following properties
are implemented and verified in the real execution path. A helper, prompt, or
test double does not satisfy an item on its own.

## Non-negotiable release gates

1. All production packages pass lint and typecheck in PR CI, including Core.
2. Deterministic safety evaluations pass with complete tool, approval, and
   artifact evidence. Financial, recovery, and RPA safety cases are 100% pass.
3. A goal cannot be released when a configured independent evaluator rejects,
   fails, or is unavailable; only the user can explicitly clear a goal.

## Durable execution

1. A workflow run has a versioned definition, stable run id, revision, and
   per-step idempotency key.
2. State is persisted before an executor begins a step and every mutation is
   atomic and revision checked.
3. An interrupted external side effect becomes `unknown_outcome`; it cannot be
   replayed until reconciliation or human takeover resolves it.
4. Every step will eventually emit an attributable trace with a run id, step
   id, approval decision, redacted evidence, and outcome.

## RPA

1. The production RPA control plane stays outside the Core kernel in
   `packages/desktop/src-tauri/src/native_rpa/`. `packages/rpa` is a legacy
   TypeScript comparison surface until its remaining parity evidence is closed.
2. The native driver launches installed Chrome or Edge with an owned,
   tenant/platform-isolated profile. It never downloads Playwright Chromium.
3. The model selects short-lived `@wN` and `@eN` semantic references from
   encrypted artifacts. Deterministic Rust resolves bounds and invokes the real
   OS mouse or keyboard; raw model-provided coordinates are not accepted.
4. Window inventory, accessibility snapshots, screenshots and receipts bind to
   one RPA run. Side effects pass policy and confirmation, and interrupted
   external actions become `unknown_outcome` rather than being replayed.
5. Release acceptance still requires installed Windows/macOS real-click runs,
   Safari WebDriver contract evidence and process-tree cleanup evidence.

## Evaluation and rollout

1. The deterministic suite covers coding verification, financial spreadsheets,
   policy denial, recovery, and RPA approval/recovery. It writes a CI artifact.
2. Real browser/desktop RPA cases use isolated accounts and run only in a
   dedicated nightly or manually approved environment.
3. Model-facing quality claims require a separate fixed task corpus with
   baseline success rate, cost, latency, and safety-regression reporting.

## Migration rule

The existing VM-based `workflow` tool remains exploratory and non-durable. The
`durable_workflow` tool is the restart-safe path for supported declarative
steps; arbitrary scripts, sub-agents, and external actions must not be
represented as recoverable or used for irreversible workflows until they have a
scheduler-integrated capability contract.
