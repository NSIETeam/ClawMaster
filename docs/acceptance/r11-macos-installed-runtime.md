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
- Final version bump, Pages links, downloaded-artifact hashes, and release notes
  must all agree before the one consolidated push and beta tag.

Keep #21 open until these gaps are closed.
