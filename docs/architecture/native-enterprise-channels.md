# Native Enterprise Channel Boundary

ClawMaster connects Feishu/Lark, DingTalk and WeCom through the Rust desktop
runtime. The production path does not start a Node channel worker.

## Runtime contract

- Platform secrets are stored in macOS Keychain or Windows Credential Manager.
  `channels.json` contains only non-secret identifiers and verification time.
- Saving configuration performs real official-endpoint authentication before
  the configuration is accepted.
- Feishu/Lark, DingTalk Stream and WeCom bot mode own restartable WebSocket
  loops. Inbound queues and duplicate-message windows are bounded.
- The native runtime owns per-chat sessions and generates replies through the
  same model gateway and usage ledger as desktop turns.
- Stopping a connector cancels its in-flight channel turns before the worker is
  removed. Disabled connectors have no reconnect loop.

## Status delivery

`NativeChannelState` is the single owner of connector status. Every transition
and processing error updates the same typed Rust status store. While the settings
panel is open, it reads `channel_status_get` on a bounded two-second interval and
stops the timer when the panel unmounts. Background connector state never owns a
desktop window handle; this keeps the Rust test binary independent of Tauri's
Windows windowing imports.

## Remaining release evidence

Fixture and localhost WebSocket tests prove framing, authentication ordering,
deduplication and status delivery, but they are not live platform acceptance.
Issue #12 remains open until dedicated staging tenants prove authorization,
inbound receipt, reply, disconnect recovery and duplicate-delivery idempotency
for Feishu and WeCom, without sending test messages to production users.
