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

Issue #15 must remain open until installed Windows x64 and macOS arm64 builds
perform a visible real click, cancellation leaves no owned browser descendants,
Safari passes its system WebDriver contract, and screenshots, approval, audit
and receipts are demonstrated on one run. Fixture tests do not replace this
installed evidence.

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
