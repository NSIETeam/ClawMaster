---
description: "Collect and validate installed ClawMaster candidate evidence for desktop and Android delivery."
---

# Installed release acceptance

English | [中文](README.zh.md)

## Summary

Each candidate needs evidence from its installed applications. The [acceptance checker](../scripts/release-acceptance.mjs) binds a candidate version and full source commit to the install lanes selected for that release, verifies the retained installer and evidence hashes, and rejects missing mandatory checks. Beta versions require Windows x64 NSIS and Apple Silicon DMG; other release versions require the full five-lane matrix. It validates evidence integrity and completeness; it cannot turn a fabricated test report into a real device observation.

## Table of Contents

- [Collect evidence](#collect-evidence)
- [Required observations](#required-observations)
- [Validate publication readiness](#validate-publication-readiness)
- [Current verification limits](#current-verification-limits)

<a id="collect-evidence"></a>
## Collect evidence

Start a template with `--template --version <candidate> --commit <full-commit> --upgrade-from <supported-old-version>`; repeat `--upgrade-from` for each supported version. The tool writes JSON to standard output and marks every installer `not-run`. Save the manifest with the corresponding files in a private evidence directory. Credentials and actual business conversations do not belong in the evidence artifact.

The installer lanes cover Apple Silicon DMG, Windows x64 NSIS, Linux x64 AppImage, Linux x64 DEB, and Android universal APK. Intel Mac is excluded. Record the actual platform, architecture, OS version, isolated environment, installed product version and source commit. Hash each exact installer; a successful build, extracted payload, or another platform's window cannot establish an installed result.

A completed lane includes `artifact: { file, sha256 }`, a `signature` result, `scenarios`, an `upgrades` entry for each declared historical version, and `integrations`. Each passing result retains at least one `{ file, sha256 }` evidence descriptor. Paths are relative to the selected artifact root; links, traversal, empty files and changed bytes are rejected. Keep commands, screenshots, machine-readable observations and logs sufficient for an independent reviewer to reproduce the claim. The [validator tests](../scripts/release-acceptance.test.mjs) describe parser cases; their synthetic files are never release evidence.

<a id="required-observations"></a>
## Required observations

Desktop checks cover installation, first startup in a clean user profile, network-failure recovery, normal exit and restart, Chinese and space-containing paths, supported-version upgrades, uninstall data policy, update rollback, optional-component-failure recovery, approval allow/deny, cancellation, and failed writes with no partial commit. The optional-component scenario disables one feature component and verifies that the app stays open, that feature reports unavailable, and core session use plus unrelated features continue. Every upgrade records preservation of settings, credentials, sessions and business data. Android additionally owns allow/deny approval, cancellation and conversation persistence checks; desktop Office or shell behavior is not inferred for Android.

Publisher verification uses `developer-id-notarized` on macOS, `authenticode` on Windows, `minisign` for Linux release payloads, and `android-apk` for Android signing. Record the observed publisher identity and retain the operating system's verification output. An ad-hoc macOS signature and a Tauri download signature cannot substitute for Developer ID, Apple notarization or Authenticode. Missing certificates produce `blocked`, with the missing prerequisite in `reason`.

Every lane needs a successful real-model request whose credential came from that platform's OS secure credential store. Desktop lanes also need an installed browser click through Native RPA, with approved execution evidence; selected-chat WeChat reading retains its own account-consent evidence. Each desktop lane separately exercises the blocked or connected state for Weixin, Feishu, DingTalk, QQ and WeCom. An unconfigured channel passes this UI check only with evidence that the application shows `blocked`, reports why it is unavailable, and does not claim a successful connection; a connected channel records explicit test-account consent and the exact client version. This matrix neither grants access to a personal account nor creates approval for collecting real messages.

Beta releases may explicitly mark `wechat-selected-read` and the five IM UI integrations `not-run` when no authorized test account is available. The manifest must state that the live connector credentials were intentionally omitted; model, Office, Native RPA, lifecycle, upgrade, network recovery, approval, rollback and write-safety checks remain mandatory.

<a id="validate-publication-readiness"></a>
## Validate publication readiness

Run `node apps/desktop-tauri/scripts/release-acceptance.mjs --manifest <manifest.json> --root <artifact-directory> --commit <full-commit> --version <candidate>`. The normal command exits unsuccessfully for incomplete acceptance. `--report-only` returns the incomplete list for preparation; its successful exit is not permission to publish. The source commit must identify the candidate that produced the installers, not the later commit that stores an acceptance report.

The [native Windows collector](../scripts/verify-windows-native.ps1) and [macOS collector](../scripts/verify-macos-native.mjs) establish their documented launch, process ownership and restart observations. Their reports retain executable paths and process creation identities at launch and at readiness; a later sample must still match, so PID reuse or replacement cannot be hidden by a matching numeric PID. Retain their output alongside the additional required scenarios. The checker does not fill missing fields from a passing build. It does not publish, alter a release, install a program or migrate user data.

<a id="current-verification-limits"></a>
## Current verification limits

The checker and its rejection tests run locally. Complete installed evidence, Developer ID/notarization credentials, a Windows publisher certificate, Android device coverage, and authorized integration accounts remain external prerequisites. The current desktop release workflow's build and native-smoke results do not supply this complete matrix by themselves. The publication job requires `release-assets/acceptance-manifest.json` and runs the strict checker against the tagged commit and version before generating update metadata or uploading a release. Missing or incomplete evidence stops publication. After checksums are recorded, `verify-release-assets.mjs` verifies the exact current asset set, every byte in `SHA256SUMS.txt`, and every public build record's source tree and component inventory before upload. It reruns strict acceptance against the final directory and requires each lane to name its exact public installer, including the DMG and APK; regenerated checksums cannot authorize a replacement installer. Stage the reviewed evidence files at the release directory root and use those basenames in the manifest, because the final asset set is flat. `test:update-manifest` executes the actual workflow shell step with missing and incomplete evidence and verifies that it never reaches publication. The current build jobs do not collect the full manifest; publication remains blocked until those independently reviewed artifacts are supplied.
