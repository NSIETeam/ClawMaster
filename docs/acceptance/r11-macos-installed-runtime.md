# macOS Installed Runtime Acceptance

Release gate: #21

Candidate commit: `774d2a7b`

Platform: macOS 26.5.1 (25F80), Apple ARM64

Artifact:
`ClawMaster_0.0.2-beta.3_aarch64.dmg`

## Build and artifact evidence

- The complete Tauri release build passed with 212 default Rust tests passing,
  zero failures, and six explicitly documented opt-in tests ignored.
- Desktop typecheck, lint, renderer tests, server tests, repository doctor,
  boundary validation, code-map validation, and release preflight passed.
- The optimized DMG is 5,659,440 bytes (5.40 MiB), below the 20 MiB beta
  target. SHA-256:
  `a0fedf4b431cebcaad2a7d9ea3de9d024d66a955e6324e44bffbb5134aea1f6d`.
- `hdiutil verify` accepted the final image. The application bundle is 12.70
  MiB and contains a thin ARM64 executable with hardened-runtime flags.
- `codesign --verify --deep --strict` accepted both the built bundle and the
  copy installed from the mounted DMG.

## Installed-app smoke

The latest DMG was mounted read-only, copied with `ditto` to a fresh temporary
installation directory, and verified again with `codesign`. The copied app was
not yet launched because the system Accessibility authorization dialog remains
locked. The earlier same-lineage candidate was launched directly from its
temporary installation directory, with `CLAWMASTER_USER_DIR` routed to a fresh
temporary directory, and used the signed-in user's real macOS Keychain for its
encrypted native state.

macOS accessibility inspection observed a standard `ClawMaster` window backed
by `tauri://localhost`. The visible tree included the task list, workbench,
working-directory and manual-approval controls, composer, provider selection,
and API-key secure text field. No Electron or sidecar process was present.

At 66 seconds after launch, the single application process reported:

| Metric | Observed |
| --- | ---: |
| CPU | 0.0% |
| RSS | 32,576 KiB |
| Child processes | 0 |

The application received a normal application quit request and exited with
status 0. Its PID disappeared, no child process remained, and the DMG was
ejected.

## Model credential restart evidence

The installed application restored the previously configured `rpa-acceptance`
model on first launch without showing model setup or asking for the API key
again. The model definition remained in encrypted native state while the secret
remained in the existing macOS Keychain service. A focused restart regression
also reconstructs `NativeRuntime`, saves the same model without an `apiKey`,
and proves that the stable credential ID resolves the existing credential
without writing it into the state store.

This is credential persistence evidence only. `rpa-acceptance` is the local
acceptance provider, not evidence of a live commercial model. Its fixed final
response must not be used to judge whether preceding tools succeeded. The final
installed candidate still needs a real-provider streaming conversation using
the user's existing secure credential.

## Installed RPA permission finding

The installed model path completed browser launch, bounded window discovery,
focus, and semantic snapshot. Native fill returned from the low-level adapter,
but a fresh accessibility inspection proved that the input remained empty and
the following bounded wait timed out. System Settings then showed that
`ClawMaster` was absent from Privacy & Security > Accessibility; only ChatGPT,
Codex Computer Use, and the disabled legacy Otto entry were present.

Commit `774d2a7b` therefore adds an `AXIsProcessTrusted` preflight before every
native keyboard or mouse action. An untrusted installed app now fails closed
with actionable guidance instead of recording a misleading successful input
receipt. Final positive input/click/drag evidence still requires adding and
enabling the latest installed candidate in the macOS Accessibility list and
restarting it.

### Subsequent installed retry: still failing

The later interactive retry enabled the candidate ClawMaster application in
Accessibility. The installed model/tool sequence still did not complete: the
fill step was followed by an unsuccessful text wait, and later harness steps
cascaded after missing results. The harness nevertheless emitted its fixed
completion message. Accessibility permission alone is therefore not a verified
explanation or complete fix for this installed-path failure.

The failed harness and its temporary outputs were subsequently removed during
the requested workspace cleanup. This narrative records the observed failure;
it is not a reproducible positive acceptance receipt. The next run must retain
a secret-free receipt, stop at the first failed or unknown tool outcome, and
inspect the selected window immediately after input before proceeding.

Conversation failure rendering and stored tool outcomes were added in
`60c55240`; those changes prevent loss of failure context but do not establish
that native input works. Both platforms still require installed acceptance
against the final consolidated candidate. Do not close the release gate using
the earlier source-level browser smoke or the harness's final model text.

## 2026-09-07 installed beta.3 follow-up

The application at `/Applications/ClawMaster.app` now reports
`0.0.2-beta.3`. Its executable SHA-256 matches the built candidate:
`af441eb60c30591f499e3a74a345fb065e07a45abe7f9eb91c7586ca44988768`.
The 5.40 MiB DMG SHA-256 is
`aac8c28b15736954a00a7d5b0b7e8ee357de8cc880b5c5614dfd66ce86048fa9`.

The installed model settings initially contained only the loopback
`rpa-acceptance` fixture. Using the user's previously supplied credential through
the secure model form, DeepSeek `deepseek-chat` was saved and selected. A fresh
conversation asking for 2 + 3 without tools returned `5` through the installed
application. After normal quit and reopening the exact installation path, the
model remained selected, the answer remained in history, and no key setup was
requested. The context panel remained collapsed.

This verifies one real-provider response and model/session restoration. It does
not prove streamed chunk timing, installed RPA input/click/drag, Windows runtime,
or readiness of external enterprise platforms. The old fixture conversation
still contains its historical fixed success text; those messages are not valid
acceptance results.

## Keychain failure-path finding (earlier candidate)

The app copied from the final DMG was launched again with an artificial isolated
`HOME` and no default macOS Keychain. It stayed fail closed and did not create
an unencrypted fallback. Instead of the previous Tauri setup panic, the app
opened a persistent `ClawMaster - 安全启动失败` page that explained the system
Keychain was unavailable, stated that no unencrypted data had been written, and
asked the user to repair or unlock Keychain before reopening the app.

The page was verified through the macOS accessibility tree. It exposed only the
bounded user-facing explanation; the internal `NativeStateStore` error and data
paths were not rendered.

## Generated-file editor acceptance (2026-09-07)

The real DeepSeek run created `clawmaster_editor_verified_20260907.pptx`
with three slide XML entries. Starting from a collapsed right panel, its
successful native tool result expanded the editor and displayed all three
slides' extracted text. A separate real `write_file` run created
`clawmaster_editor_save_check_20260907.md`, opened it automatically, and accepted
an edit in the right-hand text area. The source on disk remained unchanged.
This proves generated-file routing and editable text extraction, not lossless
Office layout editing. Old conversations were not rewritten.

The investigation fixed these concrete defects:

- Tool-round preambles no longer concatenate into the final assistant answer.
  Live preambles move into the expandable process trace.
- Failed attempts remain visible without declaring the entire task unfinished
  merely from their count; model success text is not independent verification.
- Confirmed native outputs receive an exact-file read grant before being routed
  to the editor. No sibling or outside-workspace read grant is added.
- Native string errors are shown rather than replaced by a generic failure.
- Text editing exports default to an `-edited.md` copy, reject Office extensions,
  and reject the original source path.
- File and folder pickers and both save commands run asynchronously: the installed
  save test exposed a main-thread deadlock in the previous synchronous commands.
  This system-dialog threading change requires native GUI acceptance, not a mock.

The updated candidate built successfully: 217 Rust tests passed, 6 external tests
remained ignored, and the 80 focused renderer tests plus 17 right-panel tests passed. Renderer typecheck,
focused lint, and the code-map check passed. The prior UI smoke covered wide/light
and short/dark layouts, editor, mind map and platform entries with a preview bridge;
it did not cover native file-dialog threading.

Installed executable SHA-256 (matches the build output):
`80c409e9052206589ae3e12a04095788ff85094e7630b8cae459808d2298f12b`.
DMG SHA-256: `1639042663248bce7bb63a4d6b977ad1e2a56c9819f0b18245bb796619996a28`.
The verified DMG is 5.41 MiB; the native bundle is 12.72 MiB.

After the Mac became available, the installed candidate completed the native
save acceptance through the new local file-editor entry, without a model call.
The OS picker opened the existing Markdown fixture, the editor accepted the
modified text, and the Save dialog wrote
`clawmaster_editor_save_check_20260907-verified.md` beside the source. A filesystem
assertion verified the exact edited contents and the unchanged source. Reopening
the picker and cancelling preserved the current editor contents and responsive UI.
The earlier hung save attempt is not counted as a passing export.

Exports now use atomic create-new semantics: a hard link, existing file, or path
replaced between validation and creation cannot be truncated. A dedicated Rust
regression covers the hard-link and existing-destination cases. Direct local
editing requires no transmission of the local path or contents to a model.

This candidate includes the workspace's separately edited Zhixin Pigeon HTTPS
URL; the preview smoke expectation was synchronized with that existing change.
Those platform configuration edits are separate from this editor fix. No release
or GitHub push was performed for this acceptance pass. Full Office layout editing
and the other product-wide release gates remain outside this narrow acceptance.

## Model capability follow-up (source regression only)

After the installed editor acceptance, the runtime capability manifest was found
to advertise obsolete `convert_document` and `generate_document` tool names.
These now map to `merge_pdfs`, `optimize_pdf`, and `generate_docx`, with native
argument examples. A regression checks every advertised tool against the native
agent/RPA catalog. The model-facing capability result keeps a bounded structured
index instead of truncating the entire manifest to its first 480 characters.

Tool call identities are now scoped to session, turn, model round, and provider
call ID. This prevents provider/fallback IDs reused in later rounds or other
sessions from colliding with the kernel and tool-result artifact records. The
same ID within the same round remains a conflict, rather than gaining a new
identity that would weaken replay detection.

Full native regression: 220 passed, 6 external tests ignored. These follow-up
changes have not been rebuilt into the installed candidate whose hashes appear
above. A new installed real-provider programming/RPA run is still required;
these tests do not prove the cause of every earlier repeated model response or
measure a latency improvement.

## Production tool-loop regression (source only)

The regression now invokes `NativeRuntime::run_model_tool_loop` itself instead
of manually stitching together gateway and kernel calls. A small desktop-local
host interface substitutes only window event delivery and supplies the existing
file grant implementation. Real kernel transitions, confirmation responses,
encrypted result storage, checkpoints, and native PPTX generation still run.

Two bounded loopback HTTP fixtures cover capability discovery, PPTX generation,
and a final reply across three model rounds. Both tool rounds deliberately use
the same provider call ID. Assertions verify distinct runtime IDs, the complete
native capability index in the next model request, and a final reply containing
no intermediate planning prose.

- Approval creates exactly three slide XML entries, grants the generated file,
  and emits a successful typed result with its canonical `generatedFile.path`.
- Denial creates no output, grants no file, emits a failed/cancelled typed result,
  and leaves no pending confirmation.
- `npm run doctor`, `git diff --check`, and `npm run code-map:check` pass.
- Full native library regression: 222 passed, 0 failed, 6 external tests ignored.

These fixtures use temporary directories and dummy credentials. They do not
contact DeepSeek, exercise a WebView, prove installed RPA behavior, or update the
installed app/DMG documented above. Live-provider and installed-candidate checks
remain necessary before release.

## 2026-09-08 rebuilt candidate (not installed)

Built the production-loop follow-up from
`a01e342ce02fe1c6438b5c1e7c53321ba7a6cab8` with the existing, preserved
Zhixin Pigeon HTTPS catalog change. This is not a clean-commit release build.
The only source override is `src/renderer/moduleCatalog.ts` (desktop-relative),
SHA256 `1afa4dc736519d3a70cc33ba3d589a8e8ac73d110526865b1c7aad1a8c08a584`.
Its existing catalog regression and UI-smoke fixture changes remain uncommitted.

- Build: `npm run tauri:build --workspace=clawmaster-desktop` passed, including
  production renderer/static CSS checks, 222 native tests (6 ignored), optimized
  DMG creation, read-only DMG mounting, application identity/signature checks,
  Applications shortcut verification, and the legacy-runtime-file exclusion.
- Catalog regression: 13 passed. Renderer TypeScript check passed.
- Native executable: Mach-O ARM64; application payload 12.72 MiB.
- DMG: `packages/desktop/src-tauri/target/release/bundle/dmg/ClawMaster_0.0.2-beta.3_aarch64.dmg`,
  5.41 MiB (5,670,786 bytes).
- DMG SHA256: `b4d8a7f226d6a654cd62a5b342c44aeff1d0d603e064d423b8b12ee3a11f66ed`.
- Bundled executable SHA256: `e40e721f2523f1376c94aa46fa50c519dda3d00bfb8c8c73c7dc3a31c8ea2a24`.

CUA reported the Mac locked. No GUI acceptance or application replacement was
attempted after that report. `/Applications/ClawMaster.app` remains the earlier
candidate, executable SHA256
`80c409e9052206589ae3e12a04095788ff85094e7630b8cae459808d2298f12b`.
The new bundle is ad-hoc signed, not notarized. This build was not pushed or
published, and its existence does not close installed RPA or Windows acceptance.

## Project inference follow-up (source only, 2026-09-08)

The default unassigned-session inference now accepts uniquely named, previously
used office directories without requiring `.git`, `Cargo.toml`, or other code
markers. Unknown directories still need a real project marker for path-based
inference. Multiple referenced project roots remain unassigned instead of
silently choosing the first; a name match cannot override that ambiguity.
ASCII names match whole tokens so `presales` and `salesforce` do not select a
known `sales` project. Missing directories and regular files are rejected.

Regression tests reproduced the original failures before implementation.
Six focused project tests and the full native library suite pass (224 passed,
0 failed, 6 external tests ignored). Doctor, diff check and code-map check pass.
This is deterministic evidence-based inference, not semantic classification of
arbitrary business conversations. The change is not in the DMG above and has
not been installed or published.

## Consolidated source batch (2026-09-08, local only)

The user requires all agreed implementation and local verification to finish
before the consolidated push and installer build. No push, CI dispatch, tag,
installer build, or installed-app replacement was performed for this batch.
TypeScript dependency output was regenerated only to run local compatibility
tests; it is not a desktop installer or a shipped Node runtime.

Confirmed capability-gap modules now create a separate local refinement session
in the same project using the selected model. The desktop send path claims that
session once and starts the real native turn. File writes still require normal
approval. A module manifest is a draft, not a working capability: legacy
unverified `ready` manifests are also presented as drafts. Runtime-bound states
are `draft`, `refining`, `needs_review`, and `blocked`; model success text never
promotes a candidate to ready. Invalid project/session bindings do not expose a
navigation link into another task.

The right panel keeps provisional modules dashed and opens their existing task
instead of launching a duplicate. Relevant background status changes refresh
the selected project's tiles without scanning on every token or unrelated task.
Confirmation links survive refresh and are cleared on project selection changes.
Interrupted refinement sessions become visibly blocked at restart, without
automatically replaying model or tool operations.

The same audit found that queued turns could not be cancelled before resource
admission. A resource reservation now owns its queue entry from creation through
release. Cancellation, dropped waiters, early failures, and task replacement
release registrations and cannot later start an abandoned turn. Queue state is
part of the renderer protocol and exposes the normal stop control. Tests cover
the case where an old cancelled turn must not clear its replacement's status.

Verification for the source worktree:

- Native library: 238 passed, 0 failed, 6 opt-in/external tests ignored. Local
  model fixtures exercise automatic refinement kickoff, real native tool-loop
  execution, approved/denied writes, and refusal to self-certify readiness.
- Desktop: 175 suites, 1,290 tests passed. The first full run exposed missing
  local TypeScript dependency output and stale expectations for the transparent
  module groups, Tauri resources, and the pending HTTPS platform URL change.
  Dependencies and expectations were corrected, not skipped.
- Protocol: 38 tests passed. Desktop renderer and server typechecks, repository
  lint, doctor, boundary checks, diff check, and code-map check passed.
- The Zhixin Pigeon catalog, README, packaging contract, and UI smoke now use
  the same HTTPS endpoint. A stale insecure local override is replaced with the
  secure default; no endpoint was downgraded to pass a test.

This is source-level implementation evidence, not installed-product acceptance.
The following broader work remains unaccepted and must not be claimed complete:

- Generic missing-capability implementation, independent validation, activation,
  and rollback. This batch starts a reviewable task; it does not make arbitrary
  generated code safe or automatically usable.
- Arbitrary lossless Office editing remains out of scope. DOCX and PPTX now
  support paragraph-level edits into a new same-format copy while retaining
  unmodified package entries and surrounding OOXML structure. Signed packages,
  stale sources, unknown blocks, unsafe XML, and overwrites fail closed. XLSX
  and PDF remain read-only because equivalent safe structure-preserving editing
  is not implemented.
- Final Windows installation and final installed macOS/Windows native RPA
  checks against the same candidate, plus real tenant/channel authorization
  wherever production connectivity is claimed.
- Final repository consolidation, artifact provenance, release notes, and
  downloaded-asset checks listed below. Earlier app/DMG hashes do not identify
  the source changes in this section.

## Remaining release blockers

This is candidate evidence, not release acceptance:

- The bundle is ad-hoc signed rather than Developer ID signed and notarized.
  That remains a stable-release requirement; #21 permits it for this beta only
  when the limitation is disclosed.
- Windows x64 still needs CI-built installer provenance plus installed startup,
  shutdown, process-tree, size, and hash evidence from the same final commit.
- Real DeepSeek responses and credential reuse have been observed on macOS as
  recorded above; the corresponding final Windows installation remains untested.
- The production Rust Native RPA path has completed visible, bounded,
  approval-bound Chrome focus, input, scroll, click and drag on this macOS host
  with encrypted artifacts, 14 auditable receipts, confirmed cancellation, and
  no orphan process. The final rebuilt DMG still needs the same path invoked through the installed
  application entry point after macOS Accessibility authorization; Windows
  needs its corresponding installed run. The
  Playwright release preflight is not a substitute.
- Final Pages links, downloaded-artifact hashes, and GitHub release metadata
  must all agree before the beta tag is announced.

Keep #21 open until these gaps are closed.

## Final local source review (2026-09-08)

Before the single consolidated push, the desktop conversation was reduced to
one compact expandable process record instead of repeating the same failed-step
warning in the trace, a large alert, and the assistant reply. Stored tool
outcomes remain available for audit and the model reply is no longer rewritten.
The in-app brand mark now uses one transparent, theme-adaptive chef-hat SVG in
the sidebar, empty state, setup, and assistant response; it no longer places an
opaque app-icon background or an unrelated colored secondary mascot in chat.

DOCX and PPTX extraction now exposes stable paragraph blocks and a source
digest. Save writes a new same-format copy only, verifies that the source and
original blocks are unchanged, preserves untouched ZIP entries, rejects signed
packages, and never overwrites an existing path. Unchanged source paragraphs
with preserved boundary whitespace are accepted. Publication also has a safe
create-new copy fallback for filesystems that do not support hard links.

The final local verification set completed with no failures:

- Desktop renderer suite: 175 files and 1,291 tests passed.
- Rust desktop suite: 243 tests passed; 6 explicit external, performance, or
  real-machine tests remained ignored by design.
- Core suite: 204 files and 2,756 tests passed; 5 tests were skipped by design.
- Server Rust runtime-kernel adapter, runtime protocol tests, full repository
  typecheck, lint, doctor, integration-baseline validation, boundary validation,
  code-map check, diff check, and wide/light plus short/dark UI smoke passed.
- The integration baseline ledger now matches enterprise database schema 29 and
  its declared 2-through-29 migration range; its eight contract tests passed.
- The RPA and workflow package builds now force output regeneration so a stale
  TypeScript incremental cache cannot report success while `dist/index.js` is
  absent.

This remains source evidence. No push, CI build, tag, release, final installer
hash, or final installed-app acceptance is claimed by this section.

## First consolidated CI finding (2026-09-08)

Commit `ab691cab` was pushed once after the local gates above. Its macOS ARM64
build and product-site deployment passed, but it correctly remained unreleased:

- Windows compiled the Rust test binary, then it exited before the test harness
  with `STATUS_ENTRYPOINT_NOT_FOUND`. Pinning Rust 1.98.0 reproduced the same
  failure, so the toolchain hypothesis was rejected. A startup-only historical
  matrix proved that the process-tree/Job Object commit still launched and that
  `c73f8e37` was the first failing commit. That commit made the Rust test binary
  retain Tauri's complete Windows windowing stack solely to broadcast channel
  status. The unstable broadcast path has been removed: the channel panel now
  reads the same typed Rust status command on a bounded two-second interval,
  without making background connector state own a desktop window handle.
  Windows browser ownership therefore retains the race-safe Job Object
  implementation rather than the disproved `taskkill` workaround. Rust 1.98.0
  remains pinned for reproducible release builds, not as a claimed loader fix.
- The same Windows diagnostic run exposed six capability installation tests
  failing because open package and manifest handles prevented the staging
  directory rename. Both handles are now synced and closed before the atomic
  rename; this preserves the existing POSIX behavior and satisfies Windows file
  locking semantics.
- Production-loop tests use a host adapter that deliberately rejects desktop
  windows and file grants. Its test-only `AppHandle` implementation no longer
  links production event emission and managed window state into the unit-test
  executable. Browser snapshot and action dispatch also cross a production-only
  adapter, so exercising the complete model/tool loop cannot statically retain
  Tauri's Windows WebView implementation in the Rust test process. The
  production implementations are unchanged.
- Main CI passed 1,514 server tests and failed only when the runtime-kernel
  adapter requested locked Cargo dependencies in offline mode before the clean
  runner had fetched `syn 3.0.5`. CI now fetches that exact lockfile before the
  offline test; the test remains offline and cannot silently change versions.
- The release-version source contract also exposed a stale browser-preview
  Promise spelling before CI could reach it. The implementation was restored to
  the existing explicit contract without changing its returned version.

These are release-infrastructure fixes, not waived gates. Isolated Windows run
`34222979700` validated the final source with 236 tests passed, 6 explicit tests
ignored and no failures. The resulting main-branch Windows package run must
still pass before #21 can proceed to final installed-app acceptance.

## Final cross-platform candidate evidence (2026-09-08)

The first main-branch package run `34226110194` passed preflight and macOS ARM64
but exposed a false-negative Windows installation check: Tauri installs the
stable Rust binary name `clawmaster-desktop.exe`, while the generic bundle
verifier still expected the product display name `ClawMaster.exe`. The verifier
now uses the same internal binary contract as the NSIS smoke script, with a
regression test preventing the two checks from drifting again.

Candidate `e3a76361` then completed both CI run `34238907306` and Tauri run
`34238907329` without failures. The Windows artifact was 4,714,765 bytes. Its
installed-runtime evidence records a visible main window, graceful exit, and
zero orphan processes. The same run also records approved Edge focus, click,
drag, input, and scroll operations with 15 encrypted receipts. macOS ARM64,
release preflight, Rust tests, artifact gates, and artifact upload passed in the
same fixed candidate run.

The candidate also closes the model/tool harness gap visible in earlier UI
evidence. Tool results are now explicitly returned as harness observations and
the model is instructed to continue an observe-plan-act-verify loop. More
importantly, any failed, cancelled, or unknown tool terminal state causes the
runtime to mark the final response as incomplete; model prose can no longer
self-certify a failed turn as successful. The full local Rust suite passed 243
tests with 6 explicit ignores and no failures.

No tag or release was created by these candidate runs. The installed-app
DeepSeek and native-RPA acceptance items above remain release decisions rather
than being inferred from CI success.

## Evidence-driven harness continuation (2026-09-09)

Installed candidate observation showed that the generic WebView browser tools
could outrank the Rust Native RPA chain for a Chinese request that explicitly
asked for a real system browser and mouse click. The runtime loop existed, but
tool-catalog truncation could prevent the model from seeing the tools needed to
continue it. Starting a browser could also be followed by unsupported success
prose without window, snapshot, and click evidence.

The local release candidate now treats Chinese and English computer-use intent
as Native RPA context, prioritizes the bounded start, window, semantic snapshot,
and click chain, and excludes the internal WebView action path for an explicit
real-system-browser task. For a requested real browser click, the harness
derives required evidence only from the latest user message. A no-tool model
response with missing successful evidence triggers at most two bounded replans;
after that the result is explicitly incomplete. A failed, rejected, cancelled,
or uncertain tool result stops safely instead of causing an automatic replay.
Old browser requests in conversation history cannot contaminate a new turn.

Local verification completed before any push:

- The production-loop fixture made three real OpenAI-compatible HTTP requests
  and proved that two premature completion claims are replanned before the
  third is rejected as `incomplete_tool_evidence`.
- The complete Rust desktop suite passed 246 tests with 6 explicit external,
  performance, or real-machine tests ignored and no failures.
- The desktop renderer suite passed 175 files and 1,291 tests. Existing React
  `act(...)` diagnostics remain visible as non-failing test warnings.
- Doctor, diff check, typecheck, lint, boundary validation, code-map validation,
  scheduler acceptance, and the isolated browser RPA fill/click/extract/close
  preflight passed.
- The final local macOS ARM64 Tauri build is validly ad-hoc signed. Its complete
  app runtime is 12.81 MiB and its verified optimized DMG is 5.41 MiB. The DMG
  SHA-256 is
  `63fb6a392c70191ac3d01e8ea3219821d873a847be9f7eb62157ca2934e35476`.

This section does not claim final installed-app acceptance. The new local
ad-hoc signature caused macOS to request user approval before allowing access
to the existing encrypted runtime-store keychain item. That system prompt must
be approved by the user; it is not bypassed or automated. A separate opt-in
native RPA retry also stopped before input because its isolated Chrome window
was not observed within 20 seconds; it produced no acceptance receipt and is
not counted as a pass. No push, CI run, tag, or release is claimed here.
