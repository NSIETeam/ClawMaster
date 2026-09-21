# Agent Note: Product version reset to 0.0.1beta

Status: implemented

English | [中文](2026-09-21-product-version-reset.zh.md)

## Problem

The product carried two version lines that answered different questions: the desktop shell inherited `0.2.3-fix` from the historical desktop release line, while the server's `appVersion` RPC hardcoded `0.0.2beta` that matched nothing (register D8). After this repository became the sole ClawMaster product repository, product management reset the public product version to `0.0.1beta` as a fresh numbering start.

## Decision

The product-facing version is `0.0.1beta`. Machine-readable fields carry the semver-valid prerelease form `0.0.1-beta`: [apps/desktop-tauri/package.json](../../../../apps/desktop-tauri/package.json), [tauri.conf.json](../../../../apps/desktop-tauri/src-tauri/tauri.conf.json), and the desktop crate in [Cargo.toml](../../../../apps/desktop-tauri/src-tauri/Cargo.toml) with its lockfile entry. User-visible strings keep the literal form: the server `appVersion` and `updateCheck` RPCs return `0.0.1beta`, and the README/STATUS/DEFECTS baselines state the reset with its date.

The DSH workspace package line stays at `0.1.5-rc.2`. That line identifies the harness runtime provisioning (`harness-versions/72da6c767414dd30`) and the pinned cross-package dependency graph; renaming it would sever the correspondence with the deployed, self-restoring runtime for no product-visible change.

## Alternatives considered

**Reset all workspace packages to `0.0.1-beta` as well.** It would touch more than eighty manifests, their pinned peerDependencies, lockfiles, and the tests that assert exact versions, and would break the version correspondence with the deployed runtime provisioning.

**Use the literal `0.0.1beta` in tauri.conf.json and package.json.** That string is not valid semver; the Tauri build rejects it and updater comparisons require semver. The hyphenated form exists for the machines.

**Delete the historical release tags (`v1.8.x`, `desktop-v0.2.3`).** Already-shipped releases are historical facts; the reset renumbers the product going forward, it does not rewrite release history.

## Consequences

Installed `0.2.3` clients see a `0.0.1-beta` release as a downgrade, so the updater will not offer it; the reset starts new numbering for fresh installs and the next release, and is not an in-place upgrade path. The `appVersion` surface matches the desktop product version again, which resolves the D8 drift register entry; the structural fix — injecting the version from package.json instead of hardcoding it — remains the recorded direction.
