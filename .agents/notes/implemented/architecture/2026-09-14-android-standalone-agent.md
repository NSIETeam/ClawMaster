# Agent Note: Standalone Android agent

Status: implemented

English | [中文](2026-09-14-android-standalone-agent.zh.md)

## Problem

The Android application must execute an agent independently of a desktop or hosted ClawMaster process. The desktop package embeds a Node Host and platform-specific subprocess, tray and filesystem integrations, so changing its bundle target does not provide a supported Android runtime.

## Decision

[The Android application](../../../../apps/android/README.md) owns a native Java loop, direct HTTPS model transport, app-private notes and versioned conversation records. Its data format is separate from released DSH Session generations. The application neither imports those generations nor claims desktop plugin compatibility.

The mobile executor restricts tool execution to its declared phone-local capabilities. Every model-originated write requires native approval bound to the exact proposed values. Cancellation and commit serialize; a cancellation cannot authorize a pending write. A missing durable tool receipt after interruption is an unknown outcome, not a retry instruction. The [document and task decision](2026-09-15-android-document-tasks.md) owns Office tools and persisted approvals.

Provider credentials are encrypted using Android Keystore. Model URLs require HTTPS and contain no user info, query or fragment. Requests do not follow redirects with authorization headers. The APK has no shared-storage, shell or accessibility-control permission.

## Alternatives considered

A remote WebView client would be smaller but would require a desktop or server and would not meet the standalone requirement. Embedding the desktop Node runtime would preserve more source code while leaving native dependencies and Android process restrictions unsupported. Full desktop feature parity remains a separate product decision; unavailable tools are excluded from both execution and model-visible schemas.

## Consequences

The phone can complete a model/tool/approval loop without a ClawMaster backend, but a configured model provider and network access are still required. The [document and task decision](2026-09-15-android-document-tasks.md) supersedes the foreground-only restriction with Android-owned execution and explicit recovery rules. Mobile records and credentials are app-private and are removed by uninstall.

Core recorded-provider tests cover approval rejection, tampered arguments, revision conflicts, cancellation, unknown tools and interrupted transcripts. Release-variant instrumentation covers native approvals, Activity recreation, local persistence and Keystore round trips. APK and certificate verification remain distinct from live-model or marketplace acceptance.
