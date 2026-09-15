# Agent Note: Android document workspace and durable task approval

Status: implemented

English | [中文](2026-09-15-android-document-tasks.zh.md)

## Problem

Phone-local work needs Office files and execution that can outlive an Activity. A schedule grants permission to request a model, not permission to modify every file. Process death can occur between a write and its receipt, so restarting a task cannot imply repeating its writes.

## Decision

The [Android workspace](../../../../apps/android/README.md) keeps imported documents and immutable content-addressed revisions in private storage. Apache POI handles Office containers through an Android-compatible shaded runtime; the build pins and verifies the compatibility source archive. The executor exposes bounded text-unit reads and revision-checked edits, not a full Office layout editor. System document pickers own imports and exports; the agent cannot select arbitrary shared-storage paths.

Foreground services own user-initiated runs and Android JobScheduler owns persisted, network-aware schedules. Each run is bounded and serial. Schedules retain run outcomes and conversation identifiers; only successful recurring runs schedule their successor. Android may delay or stop work. Failed and interrupted runs require explicit owner action.

Every model write first records an immutable pending proposal. The runner releases its service/job while approval is pending. A foreground review resumes only the recorded proposal and rechecks the current revision. The record enters committing before a write; interruption in that state produces an unknown outcome rather than another authorization. Rejection and cancellation produce tool receipts without performing the write.

This partially supersedes the foreground-only scope in the [standalone Android decision](2026-09-14-android-standalone-agent.md). Its independent runtime, credential protection and non-compatibility with desktop plugins remain applicable.

## Alternatives considered

**Keep Activity-owned work.** This cannot support leaving the screen during model calls or persistent schedules.

**Automatically replay interrupted work.** A missing receipt does not prove a write failed; replay can duplicate notes or documents.

**Embed the entire desktop runtime or hand-write Office containers.** The former inherits unsupported desktop dependencies; the latter creates a large parser and serialization maintenance burden. A pinned Office library plus explicit supported text operations keeps these responsibilities separate.

## Consequences

New slide text uses POI's typed OOXML schema objects: its drawing factory depends on AWT classes absent on Android. Schema validation checks textbox structure and dimensions; device tests must also execute slide creation. Existing conversations retain earlier prompt/tool contexts when a new turn adopts the current mobile tools.

Office dependencies increase APK size. Text replacement may flatten mixed formatting within the replaced paragraph; spreadsheet replacements are literal text, and formulas are not evaluated. Macros, digitally signed documents, rendering and complex object editing are excluded. Import and export are explicit copies; original revisions remain recoverable in private storage.

Core tests exercise Office containers, stale revisions, rejected writes, persisted approval and task eligibility. Android instrumentation exercises the shipped Office runtime, foreground services and platform job registration/execution. These checks do not establish vendor-specific battery behavior, real-model availability or long-duration hardware reliability.
