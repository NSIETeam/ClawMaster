# Agent Note: Verify Node archives before publishing the download cache

Status: implemented

English | [中文](2026-09-17-node-archive-integrity-and-recovery.zh.md)

## Problem

First-launch provisioning downloads a platform Node archive when no compatible host runtime exists. Treating an existing cache filename as a completed download can reuse truncated bytes after interruption. Replacing the installed Node directory before validating that archive also destroys an available runtime when extraction fails.

## Decision

The desktop pins the selected version and platform archive to its official [Node SHA-256](https://nodejs.org/dist/v22.19.0/SHASUMS256.txt) in `runtime/config.rs`. Changing the pinned Node version requires reviewing the corresponding digest. A mirror changes the source URL only. Native and WSL provisioning validate a cached archive before reuse and validate a replacement download before removing any installed Node files.

Downloads use `tempfile::NamedTempFile` in the cache directory. Stream or digest failure and future cancellation release the private temporary file without replacing the existing cache; successful verification syncs and atomically persists the replacement. A corrupt regular cache file triggers a fresh download. A cache symlink or non-file is rejected before reading its target. The [source provisioning decision](../feature/2026-08-14-cross-platform-desktop-source-provisioning.md) continues to own bundle placement and runtime selection.

## Alternatives considered

**Fetch the digest from the selected mirror.** An altered mirror could replace both the archive and its checksum. The reviewed digest ships with the trusted desktop executable.

**Delete the old cache and stream into its final filename.** Failure would discard the prior bytes and leave an unverified file visible to the next attempt. A same-directory temporary file provides scoped cleanup and atomic replacement without a separate partial-file protocol.

## Consequences

Download tests use loopback HTTP with allocated ports and an observed progress event before cancellation. They cover valid cache reuse, corrupt cache recovery, truncated responses, wrong digests, cancellation cleanup and symlink rejection. These tests validate the shared download operation on the executing host; Windows replacement semantics, WSL extraction and clean installed first-launch acceptance still require their platform observations. Host-supplied Node binaries, dependency installation and operating-system publisher verification remain separate checks.
