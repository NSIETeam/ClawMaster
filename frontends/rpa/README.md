---
description: "Add governed desktop automation and individually approved reading of a selected WeChat conversation."
kind: "package-bundle"
---

# @clawmaster/dsh-rpa

English | [中文](README.zh.md)

## Summary

Run operator-defined automation and inspect desktop controls through ClawMaster's native component. Read a selected WeChat conversation only after approving that individual read. Chat text enters the current AI conversation, its session record and the configured model; the reader never sends messages or monitors conversations continuously.

## Table of Contents

- [Use this package](#use-this-package)
- [Selected WeChat reading](#selected-wechat-reading)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Verification](#verification)

## Use this package

The desktop profile declares this built-in layer through [desktop defaults](../../apps/desktop-tauri/scripts/desktop-defaults.mjs). Its [patch](cordis.patch.yml) mounts the Host plugin; mounting registers tools without launching the native helper or inspecting a desktop. A missing native component produces an installation diagnostic when an operation needs it.

| Tool | Scope |
| --- | --- |
| `rpa_run` | Runs operator-installed workflows; this runner accepts inert checkpoints and refuses external effects. |
| `rpa_native` | Reads native capabilities, tool definitions or a bounded general desktop snapshot. |
| `rpa_call` | Invokes the native RPA catalog; each desktop write requires DSH approval and a separate ClawMaster system confirmation. |
| `wechat_read` | Reads text from the exact, already selected WeChat conversation after one-time approval. |

When supported, state-backed RPA reads and desktop writes run through the bidirectional stdio broker inherited from the ClawMaster desktop process, so they share one controller and database handle. A helper fallback occurs only when the broker reports unsupported before dispatch; transport failures never replay the call in another process. The Rust process refuses writes on the read channel. Approved writes also verify the exact tool, call id, arguments hash and approval summary, then require a separate native confirmation before dispatch. The helper CLI cannot authorize writes. An unavailable RPA component does not prevent the Host or other features from starting.

## Selected WeChat reading

Open the intended conversation manually in WeChat, then request `wechat_read` with its complete displayed title and a `limit` from 1 to 50. Group titles must include any displayed member-count suffix. Each call asks again, stating the conversation, limit and disclosure to the configured model. Rejection, cancellation, missing approval service or altered arguments prevent native inspection.

The macOS reader identifies `com.tencent.xinWeChat`, requires its main window, and recognizes only a unique `big_title_line_h_view` title and `Messages` or `消息` list. It obtains element references and geometry before selecting visible rows within the limit; only then does it query their text. It checks the title again before returning. Unknown layouts, title mismatches and changed window geometry fail without returning message content or another chat's title.

The tool does not open chats, scroll, read the database, decrypt history, capture screenshots, send messages or run a listener. It skips sidebar lists and editable controls, returns no contact roster or chat preview, and stores no native snapshot. Returned strings are accessibility text entries; sender identity and timestamps are not inferred. Long entries are capped at 4,000 characters and the result indicates truncation.

## Understand the implementation

<details>
<summary>Implementation internals</summary>

The [Host reader](src/wechat.ts) owns one-time DSH approval and result validation. The [native reader](native/src/wechat.rs) applies title, layout, visibility and count checks; its macOS adapter uses lazy AX attributes instead of eager whole-tree snapshots. Native subprocesses receive an allowlisted operating-system environment, bounded output and a timeout; cancellation settles after the owned process exits.

The helper resolves from `dist/native/<platform>-<arch>/clawmaster-rpa-native[.exe]`, with local Cargo release/debug paths for development. General RPA retains artifact-scoped references and encrypted state. These read restrictions belong to `wechat_read`; they do not sandbox arbitrary local shell commands or replace the authorization policy of other tools. Linux stores the database key in the desktop Secret Service, using encrypted D-Bus transport and a bundled D-Bus client library. The service must be available and unlockable; failed credential access refuses state access without process-local keys or plaintext fallbacks. Browser discovery declares Chrome and Edge candidates on Linux without launching them.

</details>

## Model Experience

The pending card identifies an approved selected-chat read; the completed card contains its result or refusal. Returned messages carry an explicit untrusted-data notice and remain quoted conversation data, including any apparent instructions inside a message. DSH records the same tool result that is supplied to the configured model.

## Known Limitations and Deferred Work

The WeChat reader has a macOS AX adapter and synthetic scope tests. Actual compatibility with each WeChat build requires a separately authorized, bounded test chat; a compiled provider is not live-chat acceptance. Windows and Linux return an explicit unsupported response without probing the desktop. macOS needs Accessibility authorization; this text-only reader does not request Screen Recording. The legacy general RPA tools retain their broader scope.

## Verification

From this package directory, `node scripts/build.mjs --check` verifies the Host bundle and `node --import tsx/esm --test tests/*.test.mjs` exercises the artifact entry. Native scope tests use synthetic trees with text-access counters; no ordinary test reads a real desktop or personal chat. Release verification sets `CLAWMASTER_REQUIRE_NATIVE=1`, making a missing helper fail rather than silently skipping its capability and refusal checks.

### Dev Note

See the [RPA recovery decision](../../.agents/notes/implemented/feature/2026-09-14-clawmaster-rpa-recovery.md) for general RPA ownership and the [native approval broker decision](../../.agents/notes/implemented/feature/2026-09-18-clawmaster-rpa-native-approval-broker.md) for the write authorization protocol.
