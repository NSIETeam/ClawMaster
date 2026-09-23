# Agent Note: Installed-wheel live API test skips when the external key is absent

Status: implemented

English | [中文](2026-09-23-python-live-preflight-self-skip.zh.md)

## Problem

The Python release-shaped CI matrix hard-failed on both platforms with `DEEPSEEK_API_KEY_EXTERNAL is empty; the installed-wheel real API test cannot self-skip`. The reusable workflow declares that secret as `required: false`, the repository has never configured it, and the repository's own e2e policy is "real-API tests self-skip without DEEPSEEK_API_KEY" — the preflight contradicted all three. The failure was pure CI plumbing: the build, the wheels, and every keyless black-box test had already passed on the `desktop-v0.0.1-beta` release line's first full CI pass.

## Decision

The two preflight steps now emit a `::warning::` and export a `has-key` step output instead of failing, and the two `Run installed-wheel real API black-box test` steps additionally require `steps.preflight-*.outputs.has-key == 'true'`. With the secret configured the sequence is byte-for-byte the old behavior; without it the live test skips with a visible warning, matching the e2e policy.

## Alternatives considered

**Configure `DEEPSEEK_API_KEY_EXTERNAL` on the repository.** Rejected for now: the credential belongs to product management and its absence should not block a desktop beta; the secret can be added later without any workflow change.

**Delete the preflight steps.** Rejected: with the key present the preflight is redundant, but the explicit output keeps the skip decision observable and pinned by `scripts/ci-workflow.spec.ts`.

## Consequences

The Python release-shaped matrix can go green without an external credential, so the release line's first full CI pass can be evaluated on its real signals. The live-API coverage gap is now a visible warning instead of a red failure; it closes the moment the secret is configured.
