# Dawn Native RPA Boundary

The production desktop RPA path is a Rust control plane outside the runtime
kernel. It uses installed system browsers and operating-system accessibility,
mouse, keyboard and screenshot APIs. It does not bundle Node.js, Electron,
Python, Chromium or Playwright.

## Single-purpose components

- `native_rpa/browser.rs` discovers Chrome, Edge and Safari WebDriver, validates
  navigation URLs, derives tenant/platform-isolated profiles and launches only
  ClawMaster-owned browser process trees. POSIX uses an isolated process group;
  Windows invokes the system `taskkill /T` contract against the exact owned PID
  and treats an unconfirmed tree exit as a failed cancellation.
- `native_rpa/semantic.rs` enumerates windows, assigns artifact-scoped `@wN`
  references, resolves one selected window and captures its bounded semantic
  tree or PNG.
- `native_rpa.rs` owns durable runs, approval-bound receipts, encrypted artifact
  bindings, recovery and high-level focus, input, scroll, click, drag and wait
  dispatch.
- `native_tools.rs` is the internal low-level OS adapter for physical mouse and
  keyboard input and bounded accessibility serialization. It is not exposed to
  the production model as a raw-coordinate tool.

The model never supplies a PID or coordinate. It selects a window reference and
an element reference from immutable encrypted artifacts. Rust verifies both
artifacts belong to the same run before resolving the element center and issuing
a physical input event. Editable values are redacted from semantic snapshots.
The bounded wait action listens to the active turn cancellation channel and
persists cancellation before reading the desktop again; a successful match
produces a fresh encrypted semantic artifact rather than reusing stale bounds.

## Safety and recovery

RPA profiles are hashed by tenant and platform and never share cookies. URLs
must be HTTPS except for loopback tests and cannot contain credentials. Secret
text is rejected from the current fill contract; secret entry must use a future
system-keychain reference. Every existing profile path component is verified as
a real directory rather than a symbolic link before a browser starts. External
side effects require approval and carry an idempotency key. A rejected approval
is durably receipted without freezing the run, so a later separately approved
attempt can proceed. Once native input or another external action has begun,
both an interrupted action and an adapter error produce `unknown_outcome` and
are not automatically replayed; interrupted read-only steps may return to
pending.

## Remaining release evidence

Release gate #21 remains open until installed Windows x64 and macOS ARM64 builds
perform a visible real click, cancellation leaves no owned browser descendants,
Safari passes its system WebDriver contract, and screenshots, approval, audit
and receipts are demonstrated on one run. Fixture and component tests do not
replace this installed evidence.

The Rust component path has an explicit opt-in smoke that starts a loopback-only
test page in an installed Chrome or Edge profile, forces Chromium to expose its
complete accessibility tree, discovers the browser through
bounded `@wN` references, captures an encrypted semantic snapshot, resolves a
input and action elements through `@eN`, performs approval-bound focus, native
text input, chunked scrolling, physical click and semantic drag, waits for each
result through fresh snapshots, stores an encrypted screenshot, and cancels the
owned browser:

```bash
CLAWMASTER_REAL_RPA_SMOKE=1 \
  cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --lib \
  completes_real_browser_computer_use_with_encrypted_receipts \
  -- --ignored --nocapture
```

Set `CLAWMASTER_REAL_RPA_BROWSER=chrome` or `edge` to select an adapter. Set
`CLAWMASTER_REAL_RPA_SMOKE_EVIDENCE` to write the secret-free JSON receipt to a
chosen path. The test stays ignored by default because it requires an installed
browser plus explicit desktop Accessibility and screen-capture authorization.
The production cancellation path now requires an approval binding, writes a
terminal `browser.cancel` receipt, waits for the owned process-tree leader after
issuing termination, and persists `unknown_outcome` instead of claiming success
if termination cannot be confirmed.

On the 2026-09-07 macOS ARM64 acceptance host, the opt-in smoke passed against
the installed, Google-signed and Apple-notarized Chrome 152.0.7977.83 after the
host explicitly granted Accessibility permission. It selected window `@w1`
and semantic input/action references, performed approval-bound focus, native
input, scroll, click and drag, observed each changed state through fresh
semantic snapshots, stored encrypted semantic and PNG artifacts, wrote 14
receipts, confirmed approved cancellation, and left no Chrome descendant
process. The secret-free evidence contains only bounded references, platform
metadata, booleans, receipt count, and artifact digests. Detailed evidence is
recorded in `docs/acceptance/macos-computer-use.md`.

The real run exposed two Chromium compatibility requirements now enforced by
the production browser adapter: `--force-renderer-accessibility=complete`, a
bounded semantic depth of 16, chunked wheel events after pointer placement, and
a coordinate-correct Quartz drag sequence. The global 200-element limit and
selected-window scope remain unchanged. This component-level result does not replace the final
DMG-installed application entry-point run required by release gate #21.

The macOS process-tree regression launches a parent and background child and
confirms both PIDs disappear through the production termination path. The
Windows path verifies its PID-scoped recursive `taskkill` arguments in the Rust
suite; behavioral evidence comes from the Windows real-browser runner.

Commit `34ebe3cf` closes three pre-installation safety gaps: rejected starts are
reusable after later approval, native input failures are returned to the model
instead of being serialized as successful tool results, and uncertain dispatched
external failures remain `unknown_outcome` at both receipt and kernel layers.
The complete macOS Rust library suite passed 206 tests with zero failures and
six explicit opt-in skips. A local Windows cross-check could not compile
`aws-lc-sys` because macOS has no MSVC/Windows SDK headers; this is environment
evidence, not a waived Windows acceptance result.
