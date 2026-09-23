# Agent Note: Release publication consumed a needs list that always skips it

Status: implemented

English | [中文](2026-09-23-release-publication-needs-deadlock.zh.md)

## Problem

Commit e1e9a39142 gated publishing on an isolated-install render verification and gave the `release` job `needs: [build, isolated-install-verify]`. On a publish dispatch (`inputs.publish == true`) the `build` job's own `if` evaluates to false, GitHub propagates that skip through `needs`, and the `release` job could therefore never run: `desktop-v0.0.1-beta.*` publication became unreachable. The workflow's structural test caught the regression (`test:update-manifest` failed on the `desktop-v0.0.1-beta.5` tag, runs 35694280715 and 35695387437), and the stale assertion hid the deeper semantic break.

## Decision

The `release` job carries no `needs` again, as it was before the render-gate commit: a publish dispatch consumes the original candidate run's artifacts through `inputs.build_run_id`, so nothing in the dispatch run may gate it through `needs`. The blank-window gate is unchanged and still enforced twice: `isolated-install-verify` runs on every candidate build (it needs `build` there), and publication's `verify-release-build-run.mjs` requires the candidate run's overall conclusion to be `success`, which a failed render gate denies. The structural test now pins both facts — `release.needs` is `undefined`, and `isolated-install-verify.needs` is `build`.

## Alternatives considered

**Keep the `needs` list and add an `always()`-style condition to the release job.** Rejected: it would duplicate gate enforcement that already lives in `verify-release-build-run.mjs` and keeps a misleading dependency graph — the release job consumes artifacts from another run, so needing this run's jobs protects nothing.

**Rebuild and verify inside the publish dispatch.** Rejected: publication must consume the immutable, acceptance-tested candidate run's bytes; rebuilding in the publish run would publish artifacts no acceptance run ever saw.

## Consequences

Manual publication of `desktop-v0.0.1-beta.*` tags works again while the render gate stays on every candidate build. The failure mode this guards against — a re-adding of `needs` that silently skips publication — is now a red test instead of a surprise at release time.
