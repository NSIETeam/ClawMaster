# Agent Note: Stable desktop releases and confirmed updates

Status: implemented

English | [中文](2026-09-13-desktop-stable-confirmed-updates.zh.md)

## Problem

SemVer treats `0.2.0-release` as a prerelease, although the product uses that name for its stable release. Checking only during startup misses releases published while the application stays open; installing immediately can interrupt unsaved documents and running tasks. Linux DEB and AppImage installations require different update bytes even on the same architecture.

## Decision

The program uses a stable version without a prerelease suffix; the Git tag and release title may append the display-only `-release` suffix. The [release channel resolver](../../../../apps/desktop-tauri/scripts/release-channel.mjs) validates the program version, Tauri version and tag before publication. Stable programs publish to GitHub Latest and cannot replace an existing stable release. Prerelease programs publish as prereleases outside Latest. The desktop comparator independently rejects prerelease candidates and versions that are not newer than the running program.

The application uses the HTTPS endpoints defined by [self-hosted update publication](2026-09-15-desktop-self-hosted-update-channel.md) and the existing updater public key. A release-only background worker starts after the main window opens, checks periodically and only announces availability. Successful checks restore the normal interval; failed checks use bounded exponential retry delays. An occupied update slot defers the check without network access. Each available version is announced once per launch, while a different newer version can notify again. Debug builds and unconfigured channels do not make update requests. Quit and restart cancel and await the worker before Host teardown, so an in-flight check cannot outlive its application.

The tray action asks permission to download, uses Tauri’s signature-verifying download, then asks separately to install and restart. Declining either prompt keeps the current application running. Download or verification failure cannot reach installation. A scoped guard prevents concurrent update operations and releases ownership when a future is cancelled. Windows installation stops the Host before Tauri exits; other platforms stop it through the desktop restart path. This channel updates the desktop and its bundled runtime; it does not independently update or hot-reload DSH plugins.

The manifest includes a signed `linux-x86_64-deb` asset and retains the AppImage under `linux-x86_64`. Installer-specific selection prevents the updater from handing AppImage bytes to the DEB installer. Before publication, the [signature verifier](../../../../apps/desktop-tauri/scripts/verify-updater-signatures.mjs) uses minisign and the committed public key to verify the updater payloads and their manifest signatures. A mismatched payload, signature or key blocks publication. This extends the update ownership in [desktop shell overlays](2026-08-14-desktop-shell-overlay-plugins.md); the [desktop README](../../../../apps/desktop-tauri/README.md#release) owns operator guidance.

Manual workflow dispatch defaults to building the selected commit with the same signing, provenance and platform installation checks as publication. Only tag pushes or explicit publication input can enter the release job; build validation never moves Latest. Public candidate branches start from the public release commit so unpublished local history is not uploaded as ancestry.

## Alternatives considered

**Use the product display name as the program version.** SemVer would place it below the stable version and keep the requested formal release in a prerelease channel.

**Install immediately after downloading.** A user may agree to fetch an update while still working. A separate installation decision gives that user time to save and finish tasks.

**Check only during startup.** A desktop left open for days cannot discover a release without a restart. Periodic checks retain discovery while bounded retry delays limit requests during outages.

**Use one Linux update asset.** Tauri chooses an installer-specific target when present; a generic AppImage cannot update a DEB installation.

## Consequences

Update orchestration tests cover both cancellation points, verification failure, installation after both confirmations, guard release after cancellation, periodic checks, retry delays, notification deduplication and worker shutdown. Manifest tests require the DEB signature and separate platform mapping. Publication still requires the complete platform matrix and clean build provenance. Updater signatures authenticate release bytes; they do not provide Apple notarization or a Windows publisher certificate. Save edits before confirming installation; the updater does not inspect document drafts or complete running tasks.
