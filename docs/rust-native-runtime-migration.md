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

## Current status

- Completed: packaged Node removal, native session persistence, OS credential
  storage, OpenAI-compatible/Responses/Anthropic/Gemini SSE streaming, reasoning
  events, per-session cancellation, cancellation-safe partial history, project
  memory, and a bounded eight-step native tool loop. The first executable tool
  set is workspace read/list/search plus confirmation-gated atomic text writes;
  tool arguments are digest-only in the native audit log. Unbound sessions are
  assigned to a real project root when a message references a path below a
  `.git`, `Cargo.toml`, `package.json`, or `.agents` marker; explicit workspace
  choices are never overwritten. Repeated successful Rust tool paths are staged
  as privacy-preserving auto-Skill candidates; user confirmation writes an
  atomic project `.otto/skills/<name>/SKILL.md`, while confirmation and rejection
  suppression survive restarts. The model tool catalog now exposes the existing
  Rust DOCX writer, PDF merge/optimization engine, native input automation, and
  a capability manifest that identifies the external dependencies they replace.
  A no-shell Rust process runner adds PATH dependency checks, sanitized child
  environments, bounded output, timeout/cancellation, and confirmation-gated
  executable-plus-argv execution. Confirmed model requests can also open a
  credential-free HTTP(S) URL in the existing right-side Tauri child WebView;
  the Rust runtime emits the activation event instead of falling back to Node.
  A separately confirmed DOM snapshot reads bounded visible text and interactive
  element metadata from that live WebView while excluding form values and URL
  query parameters. Confirmed index actions can click, focus, or scroll those
  elements without evaluating model-provided JavaScript. Native MCP discovery
  and invocation support stdio and
  streamable HTTP transports with credential-store isolation, cancellation,
  timeouts, response bounds, and namespaced tool routing.
  Desktop diagnostics now come from the same Rust capability manifest, so
  replaced binaries are not reported as required dependencies.
  Feishu/Lark credentials now validate both the official access-token API and
  the official WebSocket endpoint before being stored. A Rust-native event loop
  establishes the long connection, follows server heartbeat/reconnect policy,
  ACKs inbound events promptly, restores configured connections on launch, and
  exposes honest connection/error/last-event status in settings. Inbound events
  enter a bounded, deduplicated queue after ACK: private user text and group text
  that explicitly mentions the verified bot reuse a persistent per-chat native
  session, run through the Rust model/tool loop, and reply to the originating
  chat. Existing saved credentials backfill bot identity on reconnect. This path
  is code-complete but still requires real Feishu/Lark credentials and a selected
  model for end-to-end acceptance. DingTalk Stream Mode and the WeCom AI Bot
  WebSocket protocol are also implemented directly in Rust with authenticated
  connections, bounded queues, message deduplication, application heartbeats,
  reconnect control and platform-acknowledged replies. WeCom keeps its legacy
  self-built application mode for proactive notifications. Both new paths still
  require real platform credentials and a selected model for end-to-end acceptance.
- Verified locally after the native Feishu/Lark event-stream migration:
  10,880,080-byte stripped ARM64 release executable, 10.53 MiB complete
  application bundle, and 4,630,076-byte (4.42 MiB) UDBZ macOS ARM64 DMG. The
  packaged checks found no Node executable, `.node` addon, or agent payload.
- Remaining before release: browser screenshots and post-action navigation
  stabilization for reliable RPA, remaining document adapters, real-credential
  Feishu/Lark, WeCom and DingTalk acceptance, then installed real-model and
  destructive-path acceptance.
