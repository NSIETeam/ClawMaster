---
description: Standalone Android agent, phone-local data, approval rules, and APK verification.
---

# ClawMaster for Android

English | [中文](README.zh.md)

## Summary

ClawMaster Android runs a native Java agent loop on the phone. It calls the user's HTTPS Chat Completions-compatible model directly; it does not connect to a desktop ClawMaster Host. Android 8.0 or later is required.

## Contents

- [Use](#use)
- [Data and permissions](#data-and-permissions)
- [Development](#development)
- [Distribution](#distribution)

<a id="use"></a>
## Use

Open Settings, enter a model API base URL, model ID and API key, then save. The base URL excludes `/chat/completions`. Messages and requested note content go to that configured provider; a network connection and the provider's quota are required.

The agent can search, read and propose writes to phone-local notes. Every agent write opens a native approval dialog. Existing-note writes require the revision that was read; edits made while approval is pending cause a conflict. Manual note editing uses the same revision checks.

Conversation history and notes persist across restarts. Tasks stop when the app leaves the foreground, except during Activity recreation. An interrupted tool with no durable receipt has an unknown outcome and is never retried automatically.

This mobile runtime does not include the desktop DSH plugin system, terminal, computer-control RPA, browser automation, scheduled background tasks, Graph Memory, CRM/ERP or cross-device synchronization. It is not an offline on-device language model.

<a id="data-and-permissions"></a>
## Data and permissions

The app requests Internet access only. Notes and versioned JSON conversation records stay in app-private storage. The model key uses AES-GCM with Android Keystore; it is excluded from model transcripts, logs and APK resources. Cleartext model endpoints and credential-bearing URLs are rejected; authorization headers do not follow redirects.

Removing the API key leaves notes and conversations intact. Uninstalling the app removes its local data; cloud backup and device transfer are disabled. Keep needed content elsewhere before uninstalling. The agent cannot read arbitrary shared storage or execute a shell.

<a id="development"></a>
## Development

Use JDK 17, Gradle 8.13, Android SDK 36 and Build Tools 35.0.0. The Android project is independent of the desktop pnpm build.

```sh
gradle -p apps/android :core:test :app:lintRelease :app:assembleRelease
```

Core tests replay recorded model exchanges against the shipped loop and file stores. On-device instrumentation executes release code, native approvals, Activity recreation and Keystore operations. The validation workflow retains the installed APK, force-stops it, verifies ordinary launcher navigation, and runs `ColdStartCheck` in a separate process to read the preceding run's note and tool receipt. Recorded providers prove local execution, not live provider availability.

To sign and instrument the release variant, set `ANDROID_KEYSTORE_PATH` and `ANDROID_KEYSTORE_PASSWORD`; the key alias is `clawmaster`. Then run `gradle -p apps/android :app:connectedReleaseAndroidTest`. Never commit the keystore or password.

<a id="distribution"></a>
## Distribution

The Android validation workflow builds a non-debuggable APK and runs emulator checks. Its temporary signing certificate is for validation only. Public distribution requires signing the verified APK with the retained release key, checking it with Android's `apksigner verify`, and recording its SHA-256 and certificate fingerprint. Updates require the same release key and a higher version code.

An APK build is not a Google Play publication or Android developer-account verification. The [standalone runtime decision](../../.agents/notes/implemented/architecture/2026-09-14-android-standalone-agent.md) owns the separation from the desktop runtime.
