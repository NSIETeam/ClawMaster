# Agent Note: macOS native relaunch acceptance

Status: implemented

English | [中文](2026-09-15-macos-native-relaunch-acceptance.zh.md)

## Problem

Package signatures and direct Host startup do not establish that the shipped macOS application opens its main window, closes its Host or restarts with retained data. A signal that terminates a process does not establish that the normal window-close path works.

## Decision

The [native acceptance script](../../../../apps/desktop-tauri/scripts/verify-macos-native.mjs) copies the built application to a random runner directory containing spaces and Unicode. It refuses existing desktop installations, processes and Harness homes, and creates only owned application data and an isolated DSH home. Each launch must publish a fresh runtime record matching its desktop PID, child Host, packaged digest and clean release provenance. The prepared, packaged and running manifests must match. Settings and a marker inside the sessions directory must retain their bytes across both launches.

GUI mode uses the system `osascript` to inspect the owned PID and press the main window's close button. [GitHub's image configuration](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-tccdb-macos.sh) preauthorizes that executable for Accessibility and System Events. Preflight checks the actual permission and GUI availability without requesting access or changing TCC. Missing permission is a failed GUI check. A normal close requires exit code zero, no terminating signal, a stopped record for the same run and an exited Host. Cleanup after failure targets observed owned processes, including provisioning children.

Explicit termination mode records SIGTERM as termination, allows separately recorded Host cleanup and reports `guiCloseVerified: false`. It never replaces a failed GUI check automatically. The [prepared-source decision](2026-09-14-desktop-compatibility-source-binding.md) continues to own dependency and artifact compatibility checks.

## Alternatives considered

**Treat Host readiness as native acceptance.** A healthy HTTP listener can coexist with a broken application window or close handler.

**Grant TCC permissions in the test.** Changing the machine's permission database would replace the runner prerequisite with a security-policy mutation.

**Pass when SIGTERM succeeds.** Termination is useful restart evidence, but does not exercise the product's normal close handler.

## Consequences

The script is restricted to disposable GitHub-hosted macOS runners. Its unit tests validate evidence rejection and the executable's local-run refusal without launching ClawMaster. GUI acceptance requires a successful run on the selected image; source inspection and unit tests do not supply that result. The sentinels test file preservation, not model-session replay. DMG drag installation, Gatekeeper/notarization, real accounts and external model operations require separate acceptance.
