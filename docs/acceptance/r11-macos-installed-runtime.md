# macOS Installed Runtime Acceptance

Release gate: #21

Candidate commit: `2593fa79`

Platform: macOS 26.5.1 (25F80), Apple ARM64

Artifact:
`ClawMaster_0.0.2-beta.3_aarch64.dmg`

## Build and artifact evidence

- The complete Tauri release build passed with 204 default Rust tests passing,
  zero failures, and six explicitly documented opt-in tests ignored.
- Desktop typecheck, lint, renderer tests, server tests, repository doctor,
  boundary validation, code-map validation, and release preflight passed.
- The optimized DMG is 5,639,482 bytes (5.38 MiB), below the 20 MiB beta
  target. SHA-256:
  `3da487c1f35bbbdd1619f026ac887864a3a01f7652bd9f1414c14fd6ce674c99`.
- `hdiutil verify` accepted the final image. The application bundle is 12.68
  MiB and contains a thin ARM64 executable with hardened-runtime flags.
- `codesign --verify --deep --strict` accepted both the built bundle and the
  copy installed from the mounted DMG.

## Installed-app smoke

The final DMG was mounted read-only, copied with `ditto` to a fresh temporary
installation directory, and verified again with `codesign`. The copied app was
then launched directly from that directory, with `CLAWMASTER_USER_DIR` routed
to a fresh temporary directory. The application used the signed-in user's real
macOS Keychain for its encrypted native state.

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

## Keychain failure-path finding

The app copied from the final DMG was launched again with an artificial isolated
`HOME` and no default macOS Keychain. It stayed fail closed and did not create
an unencrypted fallback. Instead of the previous Tauri setup panic, the app
opened a persistent `ClawMaster - 安全启动失败` page that explained the system
Keychain was unavailable, stated that no unencrypted data had been written, and
asked the user to repair or unlock Keychain before reopening the app.

The page was verified through the macOS accessibility tree. It exposed only the
bounded user-facing explanation; the internal `NativeStateStore` error and data
paths were not rendered.

## Remaining release blockers

This is candidate evidence, not release acceptance:

- The bundle is ad-hoc signed rather than Developer ID signed and notarized.
  That remains a stable-release requirement; #21 permits it for this beta only
  when the limitation is disclosed.
- Windows x64 still needs CI-built installer provenance plus installed startup,
  shutdown, process-tree, size, and hash evidence from the same final commit.
- A real provider round trip must be verified after a replacement API key is
  saved through the application into the operating-system credential store.
- The production Rust Native RPA path has completed visible, bounded,
  approval-bound Chrome focus, input, scroll, click and drag on this macOS host
  with encrypted artifacts, 14 auditable receipts, confirmed cancellation, and
  no orphan process. The final rebuilt DMG still needs the same path invoked through the installed
  application entry point; Windows needs its corresponding installed run. The
  Playwright release preflight is not a substitute.
- Final version bump, Pages links, downloaded-artifact hashes, and release notes
  must all agree before the one consolidated push and beta tag.

Keep #21 open until these gaps are closed.
