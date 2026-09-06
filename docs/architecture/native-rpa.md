# Dawn Native RPA Boundary

The production desktop RPA path is a Rust control plane outside the runtime
kernel. It uses installed system browsers and operating-system accessibility,
mouse, keyboard and screenshot APIs. It does not bundle Node.js, Electron,
Python, Chromium or Playwright.

## Single-purpose components

- `native_rpa/browser.rs` discovers Chrome, Edge and Safari WebDriver, validates
  navigation URLs, derives tenant/platform-isolated profiles and launches only
  ClawMaster-owned browser process trees. POSIX uses an isolated process group;
  Windows uses a suspended-process Job Object to avoid child-assignment races.
- `native_rpa/semantic.rs` enumerates windows, assigns artifact-scoped `@wN`
  references, resolves one selected window and captures its bounded semantic
  tree or PNG.
- `native_rpa.rs` owns durable runs, approval-bound receipts, encrypted artifact
  bindings, recovery and high-level action dispatch.
- `native_tools.rs` is the low-level OS adapter for physical mouse and keyboard
  input and bounded accessibility serialization.

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
test page in an installed Chrome or Edge profile, discovers the browser through
bounded `@wN` references, captures an encrypted semantic snapshot, resolves a
button through `@eN`, performs an approval-bound physical click, waits for the
result through a fresh snapshot, stores an encrypted screenshot, and cancels
the owned browser:

```bash
CLAWMASTER_REAL_RPA_SMOKE=1 \
  cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --lib \
  completes_real_browser_click_with_encrypted_semantic_receipts \
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

On the 2026-09-07 macOS acceptance host, the opt-in smoke stopped before any
desktop input because neither Chrome nor Edge was installed. That is truthful
environment evidence, not a passed click test and not a reason to substitute
Playwright or a bundled browser.

The macOS process-tree regression launches a parent and background child and
confirms both PIDs disappear through the production termination path. The
Windows Job Object path has an isolated `x86_64-pc-windows-msvc` compile check;
its behavioral evidence must come from the Windows runner.

Commit `34ebe3cf` closes three pre-installation safety gaps: rejected starts are
reusable after later approval, native input failures are returned to the model
instead of being serialized as successful tool results, and uncertain dispatched
external failures remain `unknown_outcome` at both receipt and kernel layers.
The complete macOS Rust library suite passed 195 tests with zero failures and
three explicit opt-in skips. A local Windows cross-check could not compile
`aws-lc-sys` because macOS has no MSVC/Windows SDK headers; this is environment
evidence, not a waived Windows acceptance result.
