# Agent Note: Desktop publisher signing in CI

Status: implemented

English | [中文](2026-09-25-desktop-publisher-signing-in-ci.zh.md)

## Problem

Desktop CI builds produced unsigned or ad-hoc packages because the workflow did not import publisher certificates or supply Apple notarization credentials. The strict stable acceptance checker already required Developer ID notarization on macOS and Authenticode on Windows, so operators could not satisfy those checks through the existing build path.

## Decision

macOS CI accepts a complete Developer ID, App Store Connect API key and Team ID configuration, materializes the private `.p8` key in the runner's temporary directory, and verifies the built application signature, Team ID, stapled tickets and Gatekeeper assessment. Windows CI imports a password-protected PFX only when its expected thumbprint is configured, passes that thumbprint to Tauri through a temporary configuration overlay, then verifies every built executable with Authenticode. Partial signing configuration fails before packaging. Missing credentials produce an explicitly unsigned candidate build. Later stable versions continue to require publisher signatures; the version-scoped reset exception is recorded in [the 0.0.1 reset release note](2026-09-25-reset-release-upgrade-acceptance.md).

## Alternatives considered

Allowing unsigned stable publication would contradict the publisher identity requirements in the acceptance checker. Making missing credentials fail every candidate build would prevent unsigned candidates from testing unrelated runtime and packaging changes. The workflow therefore permits clearly labelled build-only candidates while requiring complete publisher evidence for later stable publication.

## Consequences

Repository operators must configure Apple Developer ID and App Store Connect secrets plus Windows code-signing secrets and the pinned certificate thumbprint before stable publication. Build signature checks prove the produced signatures and notarization state; they do not replace clean-install scenarios, upgrades, model use, integrations or retained acceptance evidence.

## Verification

`test:bundle` runs the macOS and Windows signing-preparation tests with the desktop packaging tests. Windows-specific certificate import and workflow parsing execute on the Windows CI runner; a local run without PowerShell skips those platform checks.
