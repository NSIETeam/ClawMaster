---
description: "Collect and validate installed ClawMaster desktop release evidence."
---

# Installed release acceptance

English | [中文](README.zh.md)

## Summary

Each candidate needs evidence from its installed desktop application. The [acceptance checker](../scripts/release-acceptance.mjs) binds a candidate version and full source commit to the install lanes selected for that release, verifies the retained installer and evidence hashes, and rejects missing mandatory checks. Beta versions require Windows x64 NSIS and Apple Silicon DMG; stable desktop releases require Apple Silicon DMG, Windows x64 NSIS, Linux x64 AppImage and Linux x64 DEB. Android is outside this desktop release workflow. The checker validates evidence integrity and completeness; it cannot turn a fabricated test report into a real device observation.

## Table of Contents

- [Collect evidence](#collect-evidence)
- [Required observations](#required-observations)
- [Validate publication readiness](#validate-publication-readiness)
- [Publisher signature policy](#publisher-signature-policy)
- [Current verification limits](#current-verification-limits)

<a id="collect-evidence"></a>
## Collect evidence

Start a template with `--template --version <candidate> --commit <full-commit>` and repeat `--upgrade-from <supported-old-version>` for each supported automatic upgrade. The reset `0.0.1` release may omit `--upgrade-from`; this records that users must reinstall and that the release does not promise to preserve data from earlier versions. The tool writes JSON to standard output and marks every installer `not-run`. Save the manifest with the corresponding files in a private evidence directory. Credentials and actual business conversations do not belong in the evidence artifact.

The installer lanes cover Apple Silicon DMG, Windows x64 NSIS, Linux x64 AppImage and Linux x64 DEB. Intel Mac and Android are excluded. Record the actual platform, architecture, OS version, isolated environment, installed product version and source commit. Hash each exact installer; a successful build, extracted payload, or another platform's window cannot establish an installed result.

A completed lane includes `artifact: { file, sha256 }`, a `signature` result, `scenarios`, an `upgrades` entry for each declared historical version, and `integrations`. Each passing result retains at least one `{ file, sha256 }` evidence descriptor. Paths are relative to the selected artifact root; links, traversal, empty files and changed bytes are rejected. Keep commands, screenshots, machine-readable observations and logs sufficient for an independent reviewer to reproduce the claim. The [validator tests](../scripts/release-acceptance.test.mjs) describe parser cases; their synthetic files are never release evidence.

<a id="required-observations"></a>
## Required observations

Desktop checks cover installation, first startup in a clean user profile, network-failure recovery, normal exit and restart, Chinese and space-containing paths, uninstall data policy, update rollback, optional-component-failure recovery, approval allow/deny, cancellation, and failed writes with no partial commit. The optional-component scenario disables one feature component and verifies that the app stays open, that feature reports unavailable, and core session use plus unrelated features continue. Each declared automatic upgrade is tested in its version-specific matrix and records whether settings, credentials, sessions and business data were preserved; the reset `0.0.1` release declares no automatic upgrade path.

The reset `0.0.1` release records macOS as `ad-hoc-unnotarized` and Windows as `unsigned`; it does not claim Apple or Windows publisher verification. Retain evidence of each state and state the trust limitation in `signature.reason`. Linux AppImage and DEB payloads still require `minisign`. Every later stable release continues to require `developer-id-notarized` on macOS, `authenticode` on Windows, and `minisign` on Linux.

Every lane needs a successful real-model request whose credential came from that platform's OS secure credential store. For Native RPA, an available claim requires an approved browser click in the installed app and the tested browser version. If the release declares Native RPA unavailable, acceptance instead verifies that the installed app shows a blocked state, explains the limitation and retains that evidence; it does not require an unavailable click. Selected-chat WeChat reading retains its own account-consent evidence. Each desktop lane separately exercises the blocked or connected state for Weixin, Feishu, DingTalk, QQ and WeCom. An unconfigured channel passes this UI check only with evidence that the application shows `blocked`, reports why it is unavailable, and does not claim a successful connection; a connected channel records explicit test-account consent and the exact client version. This matrix neither grants access to a personal account nor creates approval for collecting real messages.

<a id="validate-publication-readiness"></a>
## Validate publication readiness

Run `node apps/desktop-tauri/scripts/release-acceptance.mjs --manifest <manifest.json> --root <artifact-directory> --commit <full-commit> --version <candidate>`. The normal command exits unsuccessfully for incomplete acceptance. `--report-only` returns the incomplete list for preparation; its successful exit is not permission to publish. The source commit must identify the candidate that produced the installers, not the later commit that stores an acceptance report.

The [native Windows collector](../scripts/verify-windows-native.ps1) and [macOS collector](../scripts/verify-macos-native.mjs) establish their documented launch, process ownership and restart observations. Their reports retain executable paths and process creation identities at launch and at readiness; a later sample must still match, so PID reuse or replacement cannot be hidden by a matching numeric PID. Retain their output alongside the additional required scenarios. The checker does not fill missing fields from a passing build. It does not publish, alter a release, install a program or migrate user data.

<a id="publisher-signature-policy"></a>
## Publisher signature policy

The 0.0.1 reset release may be built without Apple notarization or Windows Authenticode. Its release notes must link the first-launch security guide, and published files must have verified SHA-256 checksums. This exception applies only to the exact version `0.0.1`; it does not change later stable-release requirements.

For macOS, store the base64-encoded Developer ID `.p12` as `APPLE_CERTIFICATE`, its export password as `APPLE_CERTIFICATE_PASSWORD`, and the App Store Connect issuer, key ID and base64-encoded `.p8` contents as `APPLE_API_ISSUER`, `APPLE_API_KEY` and `APPLE_API_KEY_CONTENT` secrets. Set `APPLE_SIGNING_IDENTITY` to the exact Developer ID Application identity and `APPLE_TEAM_ID` to its Team ID as repository variables. The build verifies the application signature, Team ID, stapled tickets and Gatekeeper assessment.

For Windows, store the base64-encoded code-signing `.pfx` as `WINDOWS_SIGNING_PFX` and its password as `WINDOWS_SIGNING_PFX_PASSWORD`. Set `WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT` to that certificate's 40-character SHA-1 thumbprint as a repository variable. The runner imports only that pinned certificate, Tauri signs the application and NSIS installer, and the build checks every produced executable against the expected thumbprint.

For later stable releases, macOS requires the Developer ID and notarization settings described above; Windows requires the pinned code-signing certificate described above. The existing Tauri updater key signs update payload metadata; it does not replace platform publisher certificates. A completed signature check also does not replace the installed-app scenarios and independent evidence required above.

<a id="current-verification-limits"></a>
## Current verification limits

The checker and its rejection tests run locally. Complete installed evidence, Linux package-signing evidence and authorized integration accounts remain external prerequisites for 0.0.1; Apple notarization and Windows Authenticode are deliberately not prerequisites for this reset version. The current desktop release workflow's build and native-smoke results do not supply this complete matrix by themselves. The publication job requires `release-assets/acceptance-manifest.json` and runs the strict checker against the tagged commit and version before generating update metadata or uploading a release. Missing or incomplete evidence stops publication. After checksums are recorded, `verify-release-assets.mjs` verifies the exact current asset set, every byte in `SHA256SUMS.txt`, and every public build record's source tree and component inventory before upload. It reruns strict acceptance against the final directory and requires each lane to name its exact public installer; regenerated checksums cannot authorize a replacement installer. Stage the reviewed evidence files at the release directory root and use those basenames in the manifest, because the final asset set is flat. `test:update-manifest` executes the actual workflow shell step with missing and incomplete evidence and verifies that it never reaches publication. The current build jobs do not collect the full manifest; publication remains blocked until those independently reviewed artifacts are supplied.
