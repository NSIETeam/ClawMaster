# Rust Native Runtime Migration

ClawMaster desktop must ship one Rust runtime. The packaged Tauri application
must not depend on a Node executable, JavaScript agent payload, WebSocket
loopback server, endpoint file, or a Node ABI database binding.

## Compatibility boundary

The renderer protocol remains the frozen `{ type, payload }` contract from
`packages/server/src/protocol.ts`. Rust owns the implementation behind the
existing `desktop_connect`, `desktop_send`, `desktop_disconnect`, and
`desktop_is_connected` commands. This keeps the renderer independently
testable and avoids a simultaneous UI rewrite.

Rust must emit user-visible protocol events for failures and approval states.
It must not replace behavior with logs, silently ignore a valid frame, or fall
back to the legacy Node sidecar.

## Required slices

1. Native protocol and storage
   - session list, create, history, rename, delete, subscriptions and queueing
   - settings, model metadata, work log, knowledge, memory and skill metadata
   - atomic persistence below the Tauri application data directory
2. Native model gateway
   - OpenAI-compatible chat and Responses APIs, Anthropic and Gemini adapters
   - streaming text, reasoning, usage, cancellation and bounded retries
   - API keys only in the operating-system credential store
3. Native agent kernel
   - turn lifecycle, model routing, context compression and checkpoints
   - typed tool state, confirmation, policy and audit events
   - native file, process, browser/RPA, document, search and MCP adapters
4. Native integrations
   - Feishu, DingTalk and WeCom connectors behind the channel interface
   - schedules, proactive work, project assignment and auto-Skill promotion
   - enterprise calls remain remote HTTP APIs; no enterprise server is bundled
5. Removal and release gate
   - delete `agent_sidecar.rs` and all endpoint/WebSocket client code
   - delete Node capsule, agent payload and `better_sqlite3.node` preparation
   - remove those resources from `tauri.conf.json` and both release workflows
   - fail CI if a bundle contains Node, `.node`, `agent-payload`, or endpoint code

## Non-negotiable acceptance

- Windows x64 and macOS ARM64 are the only release targets.
- A clean package build performs native runtime tests before bundling.
- Installed-app smoke covers first run, model setup, one real streamed turn,
  cancellation, confirmation, restart persistence and the five platform tabs.
- The application remains usable when no API key is configured and never logs,
  serializes, or exports raw credentials.
- The final compressed installers are measured in CI. The target is 15 MB and
  the hard gate is 20 MB; size is not estimated from source trees.

