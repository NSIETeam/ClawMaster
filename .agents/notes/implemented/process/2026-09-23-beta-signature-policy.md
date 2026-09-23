# Agent Note: Beta releases accept ad-hoc signatures and ship the macOS lane only

Status: implemented

English | [中文](2026-09-23-beta-signature-policy.zh.md)

## Problem

The installed-acceptance gate requires per-lane operating-system signature verification: `developer-id-notarized` for the macOS DMG and `authenticode` for the Windows NSIS installer. Those credentials do not exist (GitHub #251 and #247 in BLOCKERS.md are the purchase items), so the `desktop-v0.0.1-beta.*` train — whose builds now pass, including the real-browser first-boot render gate — could not publish at all. Product management explicitly confirmed the gate relaxation on 2026-09-23.

## Decision

For beta versions (`<semver>-beta.N`), `BETA_ACCEPTANCE_TARGETS` narrows to the `macos-arm64-dmg` lane and accepts `signature.kind = 'unsigned-ad-hoc'`, with the codesign verification output retained as the lane's signature evidence. The Windows lane returns together with Authenticode credentials and a real acceptance device. The stable matrix is untouched: it still demands publisher notarization and Authenticode, and the existing test that ad-hoc cannot replace publisher verification still passes for stable versions. A new test pins the beta behavior: the narrowed macOS-only template validates, the Windows lane cannot be smuggled into a beta manifest, and the stable matrix refuses an ad-hoc signature.

## Alternatives considered

**Wait for the certificates before any beta publication.** Deferred to product management's choice; the confirmed decision publishes the beta now and keeps the strict policy for stable releases.

**Also waive the per-scenario evidence for beta.** Rejected: the macOS lane still collects genuine per-scenario evidence on a real device; only the signature kind is relaxed, so the gate keeps verifying everything the current credentials allow.

**Relax the Windows lane signature only.** Rejected: without a real Windows acceptance device the lane cannot be honestly executed, so it is deferred as a whole instead of being recorded with invented results.

## Consequences

`desktop-v0.0.1-beta.*` can publish with the macOS arm64 lane once its genuine acceptance evidence lands on the evidence branch; the Windows installer still appears among the candidate artifacts and must be labeled unsigned and not acceptance-tested until #247/#251 close. Beta users keep the Gatekeeper warning on first launch. When the certificates arrive, reverting this policy is a two-line change and the stable matrix has never moved.
