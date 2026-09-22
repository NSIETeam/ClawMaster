# Agent Note: Release build gates and the staged-asset script

Status: implemented

English | [中文](2026-09-22-release-stage-script-and-version-gate.zh.md)

## Problem

Two defects in `.github/workflows/desktop-release.yml` could only fail after a release was attempted, and the second could only fail after the first was fixed.

Commit `85e87e41bc` added the LZMA recompression of the macOS disk image to the `Stage release assets` step but left the three macOS tail lines and their closing brace in place a second time, without adding an opening brace. The step's PowerShell text therefore held 8 `{` against 9 `}`. PowerShell refuses to parse such a script, so the step failed on every runner, for every platform, before it could copy an installer into `release-assets/`. The malformed lines were inside an `elseif` branch, which is why the failure looks branch-specific when it is not; no tag existed after the commit, so no build had executed it.

Separately, nothing compared the release version with the versions users already have. Commit `1faa6a869c` moved `apps/desktop-tauri/version.json` from `0.2.8` back to `0.2.3` while `desktop-v0.2.7` was published. `release-channel.mjs` compares the tag with the package version, so it accepted a `desktop-v0.2.3` build, and the workflow never invoked `desktop-version.mjs --check`, which was written for `prepare-dist.mjs` and the Cargo build script alone.

## Decision

This extends [Desktop release version source](2026-09-18-desktop-version-single-source.md), which owns the version files and their synchronization.

`Stage release assets` carries one macOS tail: the disk image recompression, the disk image copy, and the updater archive with its signature.

`Validate release version` runs three checks before either platform build, in this order: `desktop-version.mjs --check` requires `version.json`, `package.json`, `Cargo.toml`, the `dsh-desktop` entry in `Cargo.lock`, and `tauri.conf.json` to agree; `release-channel.mjs` requires the tag to name that version and channel; `release-version-guard.mjs --check <tag>` requires the version to be ahead of every published `desktop-v*` tag in its own `major.minor` line. The guard reads the tag list from the checkout, so it needs the `fetch-depth: 0` the build job already requests, and it excludes the tag under construction so a candidate branch can be tagged before its build runs.

`desktop-version.mjs` gained the lockfile so its own `sync` command can produce a releasable tree. A version bump writes four files, and the workflow's `cargo test --locked` would otherwise reject the lockfile the bump left behind. Only the `dsh-desktop` entry is rewritten, and a lockfile without that entry fails closed.

`release-version-guard.mjs` resolves each tag to the program version it publishes, accepts the `-release` display suffix as naming the same version, orders prereleases below their release, and fails closed on a tag it cannot read. `release-workflow.test.mjs` rejects any PowerShell step whose braces do not balance, with the pre-fix `Stage release assets` text as its negative control, and parses every PowerShell step with `pwsh` where the runner has it.

## Alternatives considered

**Compare only the tag with the version, as `release-channel.mjs` does.** A tag and a version that agree can both name an older program than the newest published one. Only the tag list distinguishes a forward release from a repeat of an older one.

**Count every brace in the workflow text.** A brace inside a quoted literal would be a false positive. The check strips single- and double-quoted literals on one line first, and the `pwsh` parse is the authoritative check on CI.

**Reject a version that equals a published one.** `desktop-v0.2.0` and `desktop-v0.2.0-release` both name program version `0.2.0`, and the repository published both, so equality is a supported re-publication pattern. The guard rejects only a version that trails the published set.

**Compare across lines as well.** The desktop line is reset in this repository: `docs/DEFECTS-DAWN.md` records "desktop 0.0.1beta (version reset 2026-09-21)" as the tracked baseline, and after that reset every version of the new line trails `desktop-v0.2.7`. A comparison that spans lines would refuse the entire new line, so the guard scopes itself to the candidate's `major.minor` line. An accidental backwards edit inside a line — the `1faa6a869c` state — is still refused.

## Consequences

A release candidate whose version trails the newest published tag now fails in the first step of each platform build instead of producing installers that downgrade the users who install them. Bumping the desktop version is a release prerequisite the workflow states, not a convention it assumes.

The brace check covers PowerShell text only, and the `pwsh` parse runs on CI, not in a checkout without PowerShell. Neither check proves that a platform installer was signed, installed, restarted, or rolled back on a real supported machine.

## Verification

`node --test apps/desktop-tauri/scripts/release-version-guard.test.mjs apps/desktop-tauri/scripts/release-workflow.test.mjs` passes, and `npm run test:update-manifest` in `apps/desktop-tauri` includes both. Against the 18 published `desktop-v*` tags in this checkout, the guard refuses the `1faa6a869c` state with `Desktop version 0.2.3 is behind the published 0.2.7 in the 0.2 line` while accepting `0.2.8` as the next version of that line and `0.0.1` as a release on another line; the workflow reports the same three results before either platform build.
