# Agent Note: Self-hosted desktop update publication

Status: implemented

English | [中文](2026-09-15-desktop-self-hosted-update-channel.zh.md)

## Problem

Client update discovery and large downloads depend on GitHub availability when both URLs point there. Moving distribution to an existing server separates those network dependencies, but a mirror can expose partial versions, stale metadata or untrusted bytes unless publication and signing have distinct owners. An already installed native binary cannot acquire a different endpoint through a server-side or DSH profile edit.

## Decision

The native updater tries the self-hosted HTTPS manifest first and retains GitHub Latest as a fallback. The server mirrors GitHub's latest stable release; GitHub continues to own builds, signed release artifacts and provenance. The [synchronizer](../../../../apps/desktop-tauri/scripts/sync-updater-channel.mjs) runs under a dedicated unprivileged account with a pinned public key. It holds no signing private key and cannot produce a new trusted application release.

The synchronizer verifies source checksums and all five updater signatures before publication, preserving payload bytes and signatures. It rewrites only artifact URLs in the served manifest. Downloads and evidence stay outside the public directory. A verified immutable version directory becomes visible before `latest.json` is atomically replaced. A shared process lock serializes publication; prereleases, downgrades and conflicting immutable versions fail without replacing the active manifest.

A repeated version revalidates local files before a no-op. An interrupted publication can resume from a complete verified version. The public manifest is uncached; version files are immutable and cacheable. The [server reference](../../../../apps/desktop-tauri/server-updates/README.md) owns deployed paths, options and operational recovery.

The [stable desktop update decision](2026-09-13-desktop-stable-confirmed-updates.md) remains the authority for native version selection, scheduling, signature verification and user confirmation. Installed `0.2.1` binaries retain their compiled GitHub endpoint until a later native release. Server synchronization neither changes that endpoint nor republishes an existing GitHub release.

The [installed-client component decision](2026-09-15-installed-dsh-component-updates.md) owns the separate signed plugin catalog and first mount into an existing DSH profile.

## Alternatives considered

**Keep all distribution on GitHub.** It avoids another service, but leaves client checks and downloads dependent on GitHub connectivity. The server provides an independently operated HTTPS distribution path while retaining GitHub as the published source.

**Build and sign again on the server.** That introduces a second build source and requires another private-key holder. Mirroring verified signed bytes preserves release provenance and limits the server to distribution.

**Publish files directly into the active directory.** Interrupted downloads can expose incomplete content, and concurrent runs can replace each other's metadata. Staging outside the public tree and atomically switching a complete version avoid partial publication.

**Replace existing release attachments to change installed clients.** The native endpoint is compiled into each binary. Rewriting a manifest cannot rewrite that binary, and replacing stable assets breaks immutable release provenance. A later native release carries the endpoint change.

## Consequences

The server needs outbound GitHub access for discovery and synchronization, plus maintained HTTPS and sufficient storage for retained immutable versions. A healthy HTTP response does not prove the mirror is current; a stale valid primary manifest does not make the client query the fallback. Synchronization freshness therefore needs its own operational observation.

The source checksum list identifies release files, while the pinned signing key authenticates application bytes. Both server-side validation and the existing native Tauri verification remain required. Publication tests exercise missing or corrupted input, version rejection, repeated synchronization and interrupted publication recovery. Real platform installation and a new native release are separate from serving a verified mirror; server deployment alone does not establish either.
