# GitHub Actions

ClawMaster has one formal desktop delivery path: Tauri v2. Historical Otto
Electron and enterprise deployment workflows are intentionally not present in
this repository.

## Required local checks

```bash
npm run doctor
git diff --check
npm run validate:integration-baseline
npm run validate:boundaries
npm run code-map:check
npm run typecheck
npm run lint:ci
npm run test:ci
```

## CI

`.github/workflows/ci.yml` runs for pull requests to `main` and pushes to
`main` or `codex/windows-*`. It installs only from the lockfile, validates the
repository contracts, builds, typechecks, lints, runs the full test suite, and
checks the E2EE fail-closed release policy.

GitHub currently has no repository ruleset or branch protection. Until those
settings are enabled by an administrator, a green CI run is a release process
requirement rather than a GitHub-enforced merge restriction.

## Tauri release

`.github/workflows/tauri-preview.yml` is the only formal release workflow. It
runs for pull requests that touch release inputs, pushes to `main` or
`codex/windows-*`, semantic version tags, and manual dispatches.

The source-policy job requires the candidate to contain the latest
`origin/main`. A release tag must exactly equal `v<package.json version>`.
Formal artifacts are published only after all of these jobs pass:

- the reusable SQLCipher native matrix;
- the pinned Node runtime matrix;
- macOS arm64 and x64 Tauri builds and formal artifact gates;
- the Windows x64 Tauri build, install, isolated GUI smoke, and formal gate.

A successful `v*.*.*` tag run creates the GitHub Release and uploads both DMGs,
the Windows NSIS installer, and a combined SHA-256 manifest. Manual runs do not
publish unless `publish_release` is explicitly enabled.

## Reusable native workflows

`.github/workflows/sqlcipher-native.yml` builds pinned SQLCipher bindings and
records provenance for Linux, macOS, and Windows. The Tauri workflow consumes
the Node sidecar assets from this matrix.

`.github/workflows/tauri-node-runtime.yml` builds the pinned Node `24.20.0`
sidecars for macOS arm64, macOS x64, and Windows x64. The workflow verifies the
official Windows archive checksum before packaging it.
