# Agent Note: Stable desktop releases and confirmed updates

Status: implemented

English | [中文](2026-09-13-desktop-stable-confirmed-updates.zh.md)

## Problem

SemVer treats `0.2.0-release` as a prerelease, although the product uses that name for its stable release. A startup update that installs immediately can interrupt unsaved documents and running tasks. Linux DEB and AppImage installations require different update bytes even on the same architecture.

## Decision

The program uses stable version `0.2.0`; the Git tag and release title may append the display-only `-release` suffix. The [release channel resolver](../../../../apps/desktop-tauri/scripts/release-channel.mjs) validates the program version, Tauri version and tag before publication. Stable programs publish to GitHub Latest and cannot replace an existing stable release. Prerelease programs publish as prereleases outside Latest.

The application uses the public repository’s HTTPS Latest manifest and the existing updater public key. Release startup checks after the main window opens and only announces availability. The tray action asks permission to download, uses Tauri’s signature-verifying download, then asks separately to install and restart. Declining either prompt keeps the current application running. Download or verification failure cannot reach installation. A scoped guard prevents concurrent update operations and releases ownership when a future is cancelled. Windows installation stops the Host before Tauri exits; other platforms stop it through the desktop restart path.

The manifest includes a signed `linux-x86_64-deb` asset and retains the AppImage under `linux-x86_64`. Installer-specific selection prevents the updater from handing AppImage bytes to the DEB installer. This extends the update ownership in [desktop shell overlays](2026-08-14-desktop-shell-overlay-plugins.md); the [desktop README](../../../../apps/desktop-tauri/README.md#release) owns operator guidance.

## Alternatives considered

**Use the product display name as the program version.** SemVer would place it below the stable version and keep the requested formal release in a prerelease channel.

**Install immediately after downloading.** A user may agree to fetch an update while still working. A separate installation decision gives that user time to save and finish tasks.

**Use one Linux update asset.** Tauri chooses an installer-specific target when present; a generic AppImage cannot update a DEB installation.

## Consequences

Update orchestration tests cover both cancellation points, verification failure, installation after both confirmations and guard release after cancellation. Manifest tests require the DEB signature and separate platform mapping. Publication still requires the complete platform matrix and clean build provenance. Updater signatures authenticate release bytes; they do not provide Apple notarization or a Windows publisher certificate. Save edits before confirming installation; the updater does not inspect document drafts or complete running tasks.
