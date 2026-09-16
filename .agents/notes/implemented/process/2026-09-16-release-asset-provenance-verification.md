# Agent Note: Verify release asset bytes and provenance before publication

Status: implemented

English | [中文](2026-09-16-release-asset-provenance-verification.zh.md)

## Problem

The publication job can bind an acceptance manifest to the tagged commit, but the final release directory also contains installer bytes, updater metadata, signatures and build records assembled by separate jobs. A stale checksum list or incomplete public build inventory could therefore reach the upload step without a single directory-level consistency check.

## Decision

`verify-release-assets.mjs` runs after checksum generation and before publication. It requires the current four-target updater set, the three platform build records, the acceptance manifest and the release signing key. It rejects Intel Mac names, symlinks, missing or extra checksum records, changed bytes, foreign source commits or trees, dirty source records, incomplete component/lock/patch inventories, and updater manifests that name another target set or version.

The verifier accepts evidence files referenced by the acceptance manifest as release assets and includes them in the checksum set. It does not infer platform installation, publisher signing, device coverage or integrations; `release-acceptance.mjs` remains responsible for those independently retained observations.

## Alternatives considered

**Keep the workflow's inline checks only.** Inline checks bind build records to the checkout but do not verify the final directory's checksum coverage or inventory fields as one operation. The separate verifier gives the release directory one repeatable read-only check.

**Recompute checksums without verifying them.** Regenerating `SHA256SUMS.txt` would hide an edited or incomplete staging directory. The verifier reads the generated list back and hashes every retained file before upload.

## Consequences

Publication fails after staging if a release file is missing, extra, edited or associated with another source tree. Build-only dispatches remain unaffected, and missing external acceptance evidence still blocks publication through the earlier acceptance check. The verifier does not create certificates or replace real platform and account testing.
