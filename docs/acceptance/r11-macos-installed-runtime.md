# R11 macOS Installed Runtime Acceptance

Issue: #10

Candidate commit: `4b0c39bd`

Platform: macOS 26.5.1, Apple ARM64

Artifact:
`ClawMaster_0.0.2-beta.3_aarch64.dmg`

## Build and artifact evidence

- The complete release build passed twice with 185 Rust tests passing, zero
  failures, and three explicit opt-in tests ignored.
- The production renderer gate passed after retired, unreferenced Otto park
  demo styles were removed. The generated `index.html` is 359,400 bytes.
- The optimized DMG is 5,561,936 bytes (5.30 MiB), below the 10 MiB download
  target. SHA-256:
  `7e5e7b70f92e8c58fa1a82af3c053ea146601a70f3013f05463d5a405cdaf51e`.
- `hdiutil verify` accepted the final UDBZ image. The verified application
  bundle is 12.54 MiB.
- The bundled executable is 12,948,976 bytes and the icon is 199,254 bytes.
  No Node, Electron, sidecar, or helper executable is present in the bundle.

## Isolated installed-app smoke

The final DMG was mounted read-only, copied with `ditto` to a fresh temporary
installation directory, and verified with `codesign --verify --deep --strict`.
The copied app launched from that directory rather than from the build tree.

macOS accessibility inspection observed a standard `ClawMaster` window backed
by `tauri://localhost`. The visible tree included the conversation list,
workspace controls, manual-approval selector, composer, and model setup. The
model setup stated that API credentials are stored only in the operating-system
credential store.

At 34 seconds after launch, the single application process reported:

| Metric | Observed |
| --- | ---: |
| CPU | 1.1% |
| RSS | 20,944 KiB |
| Child processes | 0 |

After `SIGTERM`, the application PID disappeared and no child process remained.
The mounted DMG was then ejected.

## Remaining release blockers

This is candidate evidence, not release acceptance:

- The application is ad-hoc signed. `spctl --assess --type execute` rejects it,
  and the build did not notarize or staple it. A Developer ID signed,
  hardened-runtime, notarized artifact remains mandatory.
- Windows x64 needs the same installed process-tree, CPU, RSS, startup, size,
  signing, and cleanup evidence.
- The fixed beta baseline and candidate still need the same successful task
  corpus with task-success and token deltas.
- The 8-agent, 500-turn Rust cleanup test passes, but installed-process RSS
  growth across that workload has not yet been measured.
- Real-provider, capability-package, native-RPA, and cross-platform acceptance
  are tracked by their own open issues and cannot be inferred from this smoke.

Issue #10 must remain open until these gaps are closed.
