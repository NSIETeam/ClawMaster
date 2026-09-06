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

## Safety and recovery

RPA profiles are hashed by tenant and platform and never share cookies. URLs
must be HTTPS except for loopback tests and cannot contain credentials. Secret
text is rejected from the current fill contract; secret entry must use a future
system-keychain reference. External side effects require approval and carry an
idempotency key. A crash during an external action produces `unknown_outcome`
and is not automatically replayed, while interrupted read-only steps may return
to pending.

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
