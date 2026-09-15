# Agent Note: Separate native update channels when target requirements change

Status: implemented

English | [中文](2026-09-15-versioned-native-update-targets.zh.md)

## Problem

Removing Intel Mac from desktop releases changes the updater manifest from five targets to four. Installed updater components 0.1.0 and 0.1.1 require all five; replacing their existing endpoint's response with four targets would break validation. A server response cannot replace the parser already loaded by those clients.

## Decision

The [manifest generator](../../../../apps/desktop-tauri/scripts/generate-updater-manifest.mjs) selects either `current` or `legacy`. Current releases require Windows x64, macOS arm64, Linux x64 AppImage and Linux x64 DEB. Legacy manifests add Intel macOS. Generation requires an explicit CLI selection; reading accepts only these two complete sets. Missing files do not authorize a partial release, and unknown targets are rejected.

The v2 channel uses `/updates/clawmaster/v2/latest.json` and `/updates/clawmaster/v2/versions/` with separate service code and writable state. The legacy root manifest remains the five-target 0.2.1 response, and its immutable files remain available. Component catalogs and portable kits keep their existing root paths. Both native channels retain the same pinned release public key and the [verified-byte publication rules](2026-09-15-desktop-self-hosted-update-channel.md).

The synchronizer requires the selected GitHub asset set and manifest target set to agree. A legacy Intel artifact requires its signature and manifest entry; a current release omits both. Both sets receive the same checksum, signature, version and atomic-publication validation. The [server reference](../../../../apps/desktop-tauri/server-updates/README.md) owns migration, retained-state checks and rollback.

## Alternatives considered

**Replace the legacy endpoint in place.** Its URL is already used by strict installed parsers; source changes cannot make those clients accept the new response.

**Infer arbitrary available targets from missing files.** That could publish a release missing a required Windows, Apple Silicon or Linux artifact. Two explicit complete sets preserve mandatory platform checks.

**Reuse an older Intel installer under a new version's filename.** A valid signature does not make the enclosed application's version match a different release. Retaining the old channel preserves truthful version identity.

## Consequences

Older components continue using the retained channel until explicitly updated; a server migration alone does not move them to v2. The server retains both directories and checks that migration leaves all legacy hashes unchanged. Native installation acceptance remains specific to the three supported build targets.

Tests authenticate current and legacy artifacts with real Minisign vectors, reject missing or unknown targets and incomplete Intel entries, and verify that publishing or rejecting a v2 candidate cannot alter the independent legacy state. These checks do not establish that a server deployment or client upgrade has occurred.
