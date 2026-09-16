# Agent Note: Installed release acceptance evidence

Status: implemented

English | [中文](2026-09-16-installed-release-acceptance-evidence.zh.md)

## Problem

An installer build, a runtime smoke check and an installed-user workflow prove different things. A single green status does not identify the platform, signed payload, preserved data or actual user path that was observed. The absence of signing credentials and integration accounts must remain visible in release evidence.

## Decision

The [installed-release checker](../../../../apps/desktop-tauri/scripts/release-acceptance.mjs) validates separate Apple Silicon, Windows, Linux AppImage, Linux DEB and Android installer records against one exact candidate commit and version. It hashes every installer and referenced evidence file. Mandatory installation, restart, recovery and supported-upgrade scenarios retain their own results. Android owns explicit approval, cancellation and persistence observations instead of inheriting desktop evidence.

System publisher verification is distinct from updater download verification. macOS requires Developer ID and notarization evidence; Windows requires Authenticode evidence. Missing certificates or devices remain blocked records. Optional integrations cannot be advertised as available without passing evidence; account tests require explicit consent and an exact client version. A real provider run remains required on each platform.

The normal CLI rejects incomplete evidence. Report-only mode lists incomplete items without authorizing publication. Its template contains no passing records. The checker validates retained evidence, not the truth of a human-written claim; native collectors and independent review remain necessary. The [acceptance reference](../../../../apps/desktop-tauri/acceptance/README.md) owns collector and artifact requirements. The [release command decision](2026-09-15-desktop-release-native-command-failures.md) continues to own workflow failure propagation.

## Alternatives considered

**Treat built or extracted artifacts as installed acceptance.** An extracted payload does not exercise installer permissions, native window startup, operating-system credentials or uninstall semantics. Each installer requires its own clean-environment observation.

**Permit absent fields to mean passed or not applicable.** Missing evidence would silently shrink release scope. Only explicitly experimental or unavailable optional integrations can remain unverified; required scenarios block readiness.

**Infer code signing from an updater signature.** The updater key authenticates downloads to ClawMaster. It does not establish a macOS or Windows publisher identity, and cannot replace the operating system's verification.

## Consequences

The validator provides a repeatable refusal point and retained artifact integrity. Its tests prove rejection of missing platforms, stale source, modified files, substituted signatures, omitted scenarios and unconsented account claims, including the real CLI exit status. It does not create certificates, run device acceptance or publish a release. Native installation evidence and deployment wiring remain separate requirements before an Issue or release can be accepted.
