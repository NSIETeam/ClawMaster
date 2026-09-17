# Agent Note: Beta release evidence gate

Status: implemented

English | [中文](2026-09-18-beta-release-evidence-gate.zh.md)

## Problem

The desktop Beta gate must verify the artifacts and installed evidence users will receive without forcing unrelated platforms into each Beta build or weakening stable release requirements.

## Decision

An exact `desktop-vX.Y.Z-beta.N` tag selects Windows x64 NSIS and macOS Apple Silicon DMG builders. Stable and other prerelease tags retain the complete current platform matrix. Beta and stable candidates both require installed acceptance, source provenance, and matching workspace and desktop lockfile digests. The final gate records installer sizes against a non-blocking 20 MiB optimization target, verifies the exact checksum set before upload, then downloads the GitHub release and verifies the published bytes and provenance again. Beta publication also requires an HTTPS download-page URL configured as `CLAWMASTER_DOWNLOAD_PAGE_URL`; the page must expose the candidate version marker and both candidate installer links before and after publication.

## Alternatives considered

**Use the stable platform matrix for every Beta.** This requires Linux and Android artifacts for a two-platform desktop gate and can block unrelated validation. The Beta channel instead selects its declared Windows and macOS installer set while stable requirements remain unchanged.

**Treat the 20 MiB target as a hard size ceiling.** The issue defines package size as an optimization goal. The gate reports larger installers with exact byte counts and keeps evidence collection independent from optimization.

**Trust the local upload directory after publication.** GitHub may retain stale or incomplete release assets. Downloading the published release and comparing its exact files and checksums verifies what users can fetch.

## Consequences

The repository variable `CLAWMASTER_DOWNLOAD_PAGE_URL` must point to the HTTPS page serving the release downloads. That page must include `data-clawmaster-release-version="<version>"` and exact GitHub URLs for the Windows installer and macOS DMG. The gate fails closed when the variable is absent, the page is stale, or either URL is missing. A configured live page and platform-installed acceptance remain external release evidence; a local script test does not establish them.

## Verification

The release matrix tests prove exact Beta tags select two builders and stable tags retain every platform. Release acceptance tests reject missing platform evidence, changed installers, mixed lockfile digests, and incomplete native lifecycle results. Package-size tests prove the 20 MiB target is reported without blocking. Download-page tests reject stale versions, non-HTTPS URLs, and missing installer links. Workflow tests require installed evidence and verify exact asset bytes and provenance before publication; the release workflow performs the same asset verification after downloading from GitHub.
