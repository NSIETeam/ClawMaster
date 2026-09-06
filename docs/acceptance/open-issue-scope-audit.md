# Open Issue Scope Audit

Date: 2026-09-06

This audit separates beta release safety from long-term product ambition. An
open roadmap or external-validation issue must remain visible, but it must not
silently block an otherwise safe beta. A release tag is blocked only by an open
issue carrying the `release-blocker` label.

## Decision Rules

An item is a beta release blocker only when all of the following are true:

1. A user can encounter the behavior in the beta build.
2. Failure could make the app unusable, unsafe, destructive, or misleading.
3. The repository or an available release host can produce objective evidence.
4. The criterion is scoped to the advertised beta capability, not a future
   platform, customer, provider, or autonomous-operation ambition.

The following do not block a beta by themselves:

- a future product epic;
- a fixed performance aspiration without a reproducible baseline;
- a third-party account, certificate, design partner, or production endpoint
  that is not available to the release team;
- parity for a capability explicitly marked unavailable or preview;
- a 24/72-hour soak that can continue after a prerelease is published.

These exceptions cannot waive secret handling, destructive-action approval,
artifact integrity, supported-platform installation, or honest unavailable
states.

## Issue Decisions

| Issue | Decision | Beta acceptance boundary |
| --- | --- | --- |
| #1 | Rewrite and close after focused evidence | Tauri is the production shell, the typed bridge fails closed, and both supported installers launch. Remove the obsolete `0.0.1-preview` version requirement. Electron source deletion belongs to #10. |
| #2 | Keep as roadmap; remove from beta gate | Runtime self-modification is a multi-release security program. Beta may expose only implemented states and must fail closed for prepare/activate. Full candidate takeover and atomic self-upgrade are not credible beta requirements. |
| #3 | Close as superseded | The epic mixes obsolete baselines, every child issue, stable signing, performance research, and external acceptance. Replace it with the scoped release issue rather than editing it indefinitely. |
| #4 | Rewrite and close after focused evidence | Keep idempotent user-directory initialization, safe paths, last-known-good, atomic writes, and no plaintext secrets. Move byte-identical beta-directory proof and cross-platform junction matrix to external validation. |
| #6 | Keep as release blocker | A real model-to-tool lifecycle, approval/cancel visibility, durable state, and no production fixed echo are core product behavior. Installed crash matrices can be bounded to advertised beta operations. |
| #8 | Rewrite; keep as release blocker | Require one real OpenAI-compatible provider path in an installed build. Anthropic and Gemini adapters may remain tested preview adapters; three live provider accounts are not a beta prerequisite. |
| #10 | Rewrite; keep as release blocker | Use 20 MiB as the beta installer target and report actual size. Do not make an unproven 10 MiB aspiration, 500-turn soak, or 40% token claim a binary gate. Legacy code is removed only when its reachable replacement is verified. |
| #11 | Rewrite and close after focused evidence | Keep scope isolation, forget/supersede, bounded context, durable capsule, and usage accounting. Treat 50K/10K benchmarks and exact 40% token improvement as tracked quality evidence, not beta publication blockers. |
| #12 | Rewrite; keep as release blocker | Require honest five-platform entries, encrypted isolated sessions, no plaintext credentials, and at least one installed end-to-end connector smoke when credentials exist. Missing customer tenants remain `blocked_external`, never fake success. |
| #13 | Replace with the beta release gate | Require Windows x64 and macOS ARM64 artifacts, checksums, clean-install launch, real model smoke, secret scan, and release notes. Code-signing/notarization are mandatory for stable, not for an explicitly marked beta. |
| #14 | Rewrite and close after focused evidence | Keep signed manifest/hash/permission checks, explicit installation confirmation, isolation, rollback, and visible unavailable states. A production trust root and every heavy capability package are external rollout work. |
| #15 | Keep as release blocker | A real visible system-browser click, approval before side effects, isolated profiles, receipt/audit, cancellation, and no orphan process are defining claims and need installed evidence on both supported platforms. |
| #16 | Close as roadmap specification | It combines CompanyOS, every department, OPC, all DSH features, many external providers, migration, operations, and release. It cannot be independently reviewed or completed in one release. Preserve the document in `docs/companyos` and create small issues only when scheduled. |
| #17 | Close after its stated P0 slice evidence | Its first-stage deterministic vertical slice is independently reviewable. Real design-partner calibration and live provider rollout should be separate external-validation issues, not retroactive blockers for the source slice. |

## Proposed Beta Gate

Before creating the next beta tag:

- all open `release-blocker` issues meet their rewritten acceptance criteria;
- `npm run doctor`, diff check, focused tests, typecheck, lint, boundary, and
  code-map checks pass on the final commit;
- Windows x64 and macOS ARM64 installers come from that same commit;
- downloaded artifacts match published SHA-256 values and launch on clean hosts;
- one installed real-model flow and one installed real system-browser RPA flow
  pass without exposing credentials;
- unavailable external connectors and capabilities are visibly blocked rather
  than represented as complete;
- no release is triggered until the consolidated commit set is pushed once.

Stable release criteria remain stricter and include platform signing,
notarization, longer soak tests, and the selected external production paths.
