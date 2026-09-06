# Native Self-Modification Boundary

Issue #2 requires self-modification to be isolated, reviewable, recoverable,
and unable to overwrite the running installation. A TypeScript implementation
still exists under the legacy Electron main process, but it is not part of the
Tauri production path.

## Migrated control plane

`packages/desktop/src-tauri/src/native_self_modification.rs` now owns the first
native control-plane slice:

- requests and their audit histories are stored in the encrypted
  `NativeStateStore`, not renderer storage or plaintext JSON;
- create is idempotent when an idempotency key is supplied and rejects a key
  reused for different request content;
- repository-relative paths are bounded and reject both slash and backslash
  traversal forms;
- changes to the native shell, updater, credentials, audit, policy, migrations,
  or the self-modification controller require a security reviewer;
- terminal states cannot be replayed, and every accepted transition records the
  responsible actor and timestamp;
- Tauri exposes list, create, approve, reject, and cancel through the typed host
  bridge.

Approval and rejection commands enforce the state machine. They cannot move a
draft directly to an approved or rejected state. This matters while the native
verification executor is unfinished: an API caller cannot fabricate the
missing verification stages.

## Deliberately unavailable

The Tauri host bridge does not expose `selfModificationPrepare`,
`selfModificationVerify`, or `selfModificationBuildAndActivate`. The bridge
returns `TAURI_BRIDGE_UNSUPPORTED` rather than delegating these operations to
the Electron implementation or reporting a false success.

Issue #2 remains open until Rust owns and verifies all of the following:

- isolated Git worktree creation outside the production installation;
- candidate verification with structured evidence and explicit skipped checks;
- candidate startup with separate ports, data, credentials, and external-write
  policy;
- task drain, durable checkpoints, leases/fencing, and unknown-outcome
  reconciliation;
- signed immutable candidate versions, atomic activation, observation, and
  automatic rollback;
- a reachable GUI review surface showing diffs, permissions, checks, resources,
  cost, activation, and rollback state;
- installed negative tests and the required 24/72-hour zero-paid-idle evidence.

The legacy Electron implementation is comparison material only. It must not be
deleted until the native path has equivalent installed evidence, and it must
not be used as release evidence for Tauri.

## Verification

The native module tests cover path classification, cross-platform traversal,
idempotent encrypted persistence, approval roles, audit attribution, and
terminal-state replay rejection. The host bridge test verifies exact Tauri
command and argument names.

Current local verification:

- full Rust library suite: 199 passed, 0 failed, 3 explicit opt-in skips;
- Tauri host bridge: 16 passed;
- desktop renderer typecheck: passed;
- `npm run doctor`, `npm run code-map:check`, and `git diff --check`: required
  before the change is considered ready to merge.
