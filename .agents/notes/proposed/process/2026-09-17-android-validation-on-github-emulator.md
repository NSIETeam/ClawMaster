# Agent Note: Android validation on a GitHub-hosted emulator

Status: proposed

English | [中文](2026-09-17-android-validation-on-github-emulator.zh.md)

## Problem

Android builds and device tests should not consume resources on the user's computer, and the repository has no Android workflow despite its Android README describing emulator validation.

## Proposal

Use a GitHub-hosted Linux runner with hardware-accelerated Android Emulator for Android release builds and instrumentation tests on API 26 and API 36. Generate a disposable CI signing key, verify the APK signature and checksum, and retain the APK and evidence briefly as a validation artifact. The artifact is not a public release and cannot replace signing with the retained release key.

The workflow covers the current standalone Android implementation. Desktop feature parity remains a separate product requirement and must not be inferred from a successful build or emulator run.

## Alternatives considered

**Run the emulator on the user's computer.** This consumes local memory and CPU and conflicts with the requirement to keep Android emulator work in GitHub.

**Publish every successful workflow APK.** The CI key is disposable, so its signature cannot support an in-place upgrade or establish a distributable release.

## Acceptance criteria

- The workflow runs Android build and instrumentation checks on a GitHub-hosted Android emulator without starting a local emulator.
- It records the CI APK checksum and signer certificate and retains a clearly labeled validation artifact for seven days.
- The Android documentation describes only checks the workflow actually performs and says that validation does not establish desktop feature parity or release signing.

## Risks

GitHub runner availability, SDK downloads, or emulator boot may fail independently of product behavior. The current native Android app lacks desktop DSH features, so cloud validation alone does not meet the requested parity goal.
