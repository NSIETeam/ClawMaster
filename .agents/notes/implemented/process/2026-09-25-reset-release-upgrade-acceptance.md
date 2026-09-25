# Agent Note: Reset release 0.0.1 acceptance

Status: implemented

English | [中文](2026-09-25-reset-release-upgrade-acceptance.zh.md)

## Problem

The reset release cannot rely on Apple Developer ID or Windows Authenticode credentials, and automatic upgrades from the withdrawn 0.2.x line are not supported.

## Decision

Acceptance permits exactly version `0.0.1` to record macOS as `ad-hoc-unnotarized` and Windows as `unsigned`, with retained signature-state evidence and a disclosure in `signature.reason`. Linux AppImage and DEB signatures remain required. The first-launch guide explains checksum verification and the operating-system warning flow. Every later stable version retains the existing macOS notarization and Windows Authenticode requirements. The `0.0.1` manifest may declare no upgrade sources and must be installed manually. It skips IM UI integration checks; later stable releases retain them.

## Alternatives considered

**Require Apple and Windows signing for 0.0.1:** the credentials are unavailable and the user explicitly chose to proceed without those signatures; this would block the requested reset release.

**Accept unsigned output for all stable releases:** this would discard publisher identity checks for future releases. The exception is therefore selected only by exact version `0.0.1`.

**Require IM UI checks for 0.0.1:** the reset release can validate core desktop readiness without configuring messaging clients; later stable releases keep those integration checks.

## Consequences

The reset release lacks Apple notarization and Windows publisher identity, so first launch may show platform security warnings. Checksum validation and the linked warning guide help users verify the downloaded bytes and proceed deliberately. The reset release does not claim messaging integration readiness. Later stable releases retain their existing IM UI checks. The signature exception does not weaken the later stable-release policy.

## Verification

The acceptance tests prove that `0.0.1` accepts only documented ad-hoc macOS and unsigned Windows states, while later stable versions still require the original signature kinds. Linux lanes remain in the 0.0.1 matrix and require Minisign evidence. A regression test proves IM UI results may be absent only for 0.0.1.
