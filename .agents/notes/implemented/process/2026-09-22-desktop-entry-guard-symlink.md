# Agent Note: Desktop script entry guards resolve the invoked path

Status: implemented

English | [中文](2026-09-22-desktop-entry-guard-symlink.zh.md)

## Problem

Every desktop script under `apps/desktop-tauri/scripts/` decides whether it is the process entry point by comparing `import.meta.url` with `process.argv[1]`. `argv[1]` is the path the caller typed, while Node reports the resolved real path of a loaded ES module. Nineteen scripts compared the two after only absolutizing the argument with `resolve()`, and five compared the raw argument, so any invocation whose path traverses a symlink made the comparison false. The guard then skipped the entry point, and the process exited 0 having done nothing and printed nothing.

The documented acceptance-collection command is the clearest victim. `apps/desktop-tauri/acceptance/README.md` tells an operator to start a manifest with `release-acceptance.mjs --template`, and on macOS the natural working directories for retained evidence are `/tmp` and `$TMPDIR`, which are symlinks to `/private/tmp` and `/private/var/folders`. `node /tmp/evidence/release-acceptance.mjs --template …` wrote no manifest and reported success. The same silence applies to a checkout or a scripts directory reached through a link, such as a script copied into a temporary tree for an isolated run.

`build-provenance.mjs` already compared `realpathSync(resolve(process.argv[1]))` with `fileURLToPath(import.meta.url)`, so one correct form existed beside twenty-four incorrect ones.

## Decision

Every desktop script resolves the path with `realpathSync` before comparing it: `import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href`, and the five scripts that compare `fileURLToPath(import.meta.url)` instead use `realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)`. The imports each file needs are `realpathSync` from `node:fs` and, where absent, `resolve` from `node:path`.

`apps/desktop-tauri/scripts/entry-guard-posture.test.mjs` holds the invariant and runs in `test:update-manifest`. It rejects the three replaced forms as negative fixtures, fails for any script whose guard line mentions both `process.argv[1]` and `import.meta.url` without `realpathSync`, requires a guard in each release-critical script, and spawns `release-acceptance.mjs` through a directory symlink to assert that the entry point runs, prints a manifest template, and selects a beta matrix.

## Alternatives considered

**Leave the guards and document the restriction.** A guard that silently succeeds is worse than one that fails: the operator sees exit code 0 and an empty evidence directory. Documenting "do not use a symlinked path" also contradicts the repository rule that misconfiguration fails loud.

**Fail loudly in the guard instead of resolving.** Exiting non-zero for every symlinked invocation would reject the ordinary `/tmp` and `$TMPDIR` cases that the acceptance procedure itself encourages.

**Compare only basenames.** Two scripts with the same basename would then both believe they are the entry point.

**Accept either comparison.** Comparing the raw argument as well would keep passing under `node --preserve-symlinks`, but no launcher in this repository sets that flag, and a second accepted form hides the one this gate exists to require.

## Consequences

A script invoked through any symlinked path now reaches the same entry point as one invoked through its real path, so an operator following the acceptance README gets the manifest template instead of an empty success. The gate keeps the resolved-path form as the only accepted one across `apps/desktop-tauri/scripts/`, and it names the offending line when a new script reverts to a weaker comparison.

The gate covers the scripts directory only. The repository-level gates under `scripts/` still compare paths after `resolve()` alone, and the entry-point contract itself remains that an imported script must not run its command-line work.

## Verification

`node --test apps/desktop-tauri/scripts/entry-guard-posture.test.mjs` fails against the previous guard form and passes with it: the symlinked invocation prints the manifest template whose targets are `macos-arm64-dmg` and `windows-x64-nsis` for `0.0.1-beta.4`. Run from `apps/desktop-tauri`, `npm run test:update-manifest` reports 67 passed and 3 skipped with no failure. Running `release-acceptance.mjs --template --version 0.0.1-beta.4 --commit a506a1bb73ae67bce813c2566726b8c9e0ded763 --upgrade-from 0.0.1-beta.3` through `/var/folders/…` (a symlink to `/private/var/folders/…`) printed the template where it previously printed nothing and exited 0.
