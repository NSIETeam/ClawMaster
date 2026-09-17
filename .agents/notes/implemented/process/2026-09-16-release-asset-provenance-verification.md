# Agent Note: Verify release asset bytes and provenance before publication

Status: implemented

English | [中文](2026-09-16-release-asset-provenance-verification.zh.md)

## Problem

The publication job can bind an acceptance manifest to the tagged commit, but the final release directory also contains installer bytes, updater metadata, signatures and build records assembled by separate jobs. A stale checksum list or incomplete public build inventory could therefore reach the upload step without a single directory-level consistency check.

## Decision

`verify-release-assets.mjs` runs after checksum generation and before publication. It requires the current four-target updater set, the Apple Silicon DMG and Android APK, the three platform build records, the acceptance manifest and the release signing key. It rejects Intel Mac names, symlinks, missing or extra checksum records, changed bytes, foreign source commits or trees, dirty source records, incomplete component/lock/patch inventories, and updater manifests that name another target set or version.

The verifier reruns `release-acceptance.mjs` against the final directory and requires each installer lane to name its canonical public artifact. It includes the manifest and referenced evidence in the checksum set. A replacement installer fails even if its SHA256SUMS entry is regenerated, because the independently retained acceptance digest must still match. Platform installation, publisher signing, device coverage and integrations require real observations; parser fixtures do not supply them.

## Alternatives considered

**Keep the workflow's inline checks only.** Inline checks bind build records to the checkout but do not verify the final directory's checksum coverage or inventory fields as one operation. The separate verifier gives the release directory one repeatable read-only check.

**Recompute checksums without verifying them.** Regenerating `SHA256SUMS.txt` would hide an edited or incomplete staging directory. The verifier reads the generated list back and hashes every retained file before upload.

## Consequences

Publication fails after staging if a release file is missing, extra, edited or associated with another source tree. Build-only dispatches remain unaffected, and missing external acceptance evidence blocks both the initial and final publication checks. The verifier does not create certificates or replace real platform and account testing.
