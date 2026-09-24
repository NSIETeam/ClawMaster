# Agent Note: Keep formal release acceptance scoped to desktop installers

Status: implemented

English | [中文](2026-09-24-desktop-only-release-acceptance.zh.md)

## Problem

The desktop release workflow builds Windows, macOS and Linux installers but has no Android installer builder. Requiring an Android APK in its acceptance manifest prevents every stable desktop release from reaching publication, while falsely implying that this workflow ships an Android application.

## Decision

Stable desktop releases require installed acceptance for Apple Silicon macOS, Windows x64 NSIS, Linux x64 AppImage and Linux x64 DEB. Beta releases retain their Windows x64 NSIS and Apple Silicon DMG acceptance lanes. Android is outside this workflow and does not count as a shipped or accepted desktop installer. The acceptance checker continues to require the configured OS publisher signature and installed evidence for every desktop lane. Android can return to release scope only with a product decision, an Android builder and its own installed-device evidence.

## Alternatives considered

**Keep Android mandatory in the desktop matrix.** The workflow has no Android artifact builder, so the manifest cannot be complete from its own build outputs; this also contradicts the product decision to leave Android out of this release.

**Treat the Android lane as optional or `not-run`.** Optional status would blur which platforms the desktop publication actually ships. A desktop-only matrix gives each release a precise installer denominator.

## Consequences

Desktop publication no longer waits for Android artifacts or device tests. macOS notarization, Windows Authenticode, Linux package signatures, real installed acceptance, model and connector checks remain required for their respective desktop lanes. Excluding Android from this workflow makes no claim about Android product readiness.

## Verification

`release-acceptance.mjs` and `verify-release-assets.mjs` select the desktop installers for stable releases. Their tests reject missing desktop lanes and verify that stable manifests contain no Android lane. The [installed acceptance reference](../../../../apps/desktop-tauri/acceptance/README.md) defines the required observations.
