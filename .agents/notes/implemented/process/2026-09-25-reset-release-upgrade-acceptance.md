# Agent Note: Test only declared desktop upgrade paths

Status: implemented

English | [中文](2026-09-25-reset-release-upgrade-acceptance.zh.md)

## Problem

The release checker required a generic data-preservation scenario on every installer and a separate preservation record for each declared old-version upgrade. ClawMaster 0.0.1 is a reset release whose accepted install path is manual reinstall, so it has no supported automatic upgrade path to test.

## Decision

The 0.0.1 acceptance manifest may set `supportedUpgradeVersions` to an empty array. Later releases must name at least one supported automatic upgrade version. The checker validates each declared upgrade in its version-specific matrix, so it does not also require a duplicate generic upgrade-preservation scenario.

## Alternatives considered

**Keep the generic upgrade scenario.** It duplicates the per-version data-preservation records and incorrectly requires an upgrade path for a release whose accepted installation method is manual reinstall.

**Allow empty upgrade support for every release.** A later release could silently drop a previously promised upgrade path, so only the explicitly reset 0.0.1 version may omit automatic upgrades.

## Consequences

The reset release still requires signed installers, clean installation, first launch, restart, recovery, core feature and real-model evidence. Empty upgrade support records the manual-reinstall policy and does not weaken any installer or runtime checks. Future releases retain upgrade preservation evidence for every old version they claim to support.

## Verification

`release-acceptance.test.mjs` verifies that 0.0.1 accepts an empty upgrade matrix and later versions reject it. The same suite continues to reject a declared upgrade that does not preserve settings, credentials, sessions or business data. The [installed acceptance reference](../../../../apps/desktop-tauri/acceptance/README.md) documents the manifest rule.
