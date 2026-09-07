# macOS Computer-Use Acceptance

Date: 2026-09-07

Platform: macOS 26.5.1 (25F80), Apple ARM64

Browser: Google Chrome 152.0.7977.83, verified as Google-signed and
Apple-notarized before installation

## Production path

The Rust production model surface no longer exposes raw desktop coordinates.
The low-level Quartz input adapter is internal to Native RPA. A model must use
an encrypted window artifact and its `@wN` reference, or an encrypted semantic
snapshot and its `@eN` references. Rust resolves and validates coordinates only
after approval.

The bounded computer-use surface now covers:

- installed system Chrome/Edge launch with an isolated hashed profile;
- selected-window focus, semantic snapshot and encrypted screenshot;
- non-secret text input with native click, `Cmd+A`, and keyboard typing;
- bounded native scrolling at the selected window center;
- single click on a visible semantic element;
- drag between two visible elements from the same semantic snapshot;
- bounded extraction and text wait with a fresh snapshot;
- approval-bound cancellation and owned process-tree cleanup.

Zero-area or off-window elements are rejected before input. Fill, focus,
scroll, click with external effects, drag, and cancellation require approval.
Editable values remain redacted. Native input errors after dispatch are
persisted as `unknown_outcome` when an external effect may have occurred.
On macOS, native input also checks `AXIsProcessTrusted` before dispatch so an
unlisted app cannot report success for keyboard or mouse events that the
operating system silently discards.

## Real acceptance evidence

The opt-in acceptance run used a loopback-only page and the same Rust
controller and Quartz adapters as production. It completed focus, input,
`Cmd+A`, scrolling, re-snapshot, click, drag, wait, screenshot, and cancellation.
The page confirmed the input, click, and drag through fresh accessibility
snapshots. The run produced 14 receipts and left no Chrome or test descendant.

The secret-free receipt contains only platform/browser metadata, bounded
references, success booleans, receipt count, and encrypted artifact digests.
The final receipt is checked in at
`docs/acceptance/evidence/macos-computer-use.json`.

The run identified and fixed three macOS-specific defects rather than hiding
them: Chromium needs its complete accessibility tree enabled; its web controls
can sit deeper than eight accessibility levels; and the upstream drag adapter
constructed release events at `(0,0)`. ClawMaster now uses a 16-level/200-item
bounded tree, rejects clipped zero-area controls, moves the pointer before
chunked wheel events, and emits its own coordinate-correct Quartz drag sequence.

## Remaining release evidence

This proves the source-built production Rust path against a real installed
browser. Release gate #21 still requires the final DMG-installed application to
invoke the same path through its user/model entry point after ClawMaster is
enabled in macOS Accessibility. The installed model and Keychain credential
already restore across restart without asking for the API key again. The
Windows x64 installed package must independently pass its Edge run. Multi-application
workflows, right/double click, secure Keychain-backed secret entry, and recovery
after a forced mid-action process crash remain follow-up scope; they are not
represented as complete by this acceptance.
