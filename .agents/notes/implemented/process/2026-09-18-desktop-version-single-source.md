# Agent Note: Desktop release version source

Status: implemented

English | [中文](2026-09-18-desktop-version-single-source.zh.md)

## Problem

The desktop package manifest, Cargo manifest, and Tauri configuration each carried a release version. Package naming and release evidence consume those values through different build paths, so editing only one could produce an installer whose displayed version disagreed with its metadata or evidence.

## Decision

`apps/desktop-tauri/version.json` owns the desktop release version. `npm run version:sync` generates the `version` fields in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`; `npm run version:check` rejects any mismatch. Tauri frontend preparation runs the check before creating `dist` or bundling source. The Cargo build script independently compares all three generated versions with the canonical value, so direct native builds also fail closed.

Installer version metadata comes from Cargo, while bundle provenance and release acceptance receive the desktop package version. Both values are generated from the same file and checked before the Tauri build; the release tag validator already requires the package and Tauri versions to agree. The sync command changes only version fields and preserves the other manifest content.

## Alternatives considered

**Keep three manually edited values and compare them only during release validation.** This leaves local Tauri builds and direct Cargo builds able to produce mismatched artifacts. The version generator plus build-time checks reject drift before either package path can complete.

**Make installer, provenance, and acceptance each read the canonical file directly.** Cargo and Tauri require their own manifest versions for native metadata. Generating those required values and checking them at both build entry points gives the native toolchains their inputs while retaining one editable release value.

## Consequences

Maintainers change `version.json` and run `npm run version:sync` in `apps/desktop-tauri` before building. The positive fixture verifies synchronization; negative fixtures alter each generated version separately and require the build check to reject it. Release notes and explanatory documentation remain authored records and must be updated with a release; they do not determine packaged identity.

## Verification

`scripts/desktop-version.test.mjs` verifies agreement, rejects drift in each generated manifest, repairs that drift deterministically, and rejects an invalid canonical version without modifying generated files. `prepare-dist.mjs` executes the check, and `src-tauri/build.rs` repeats it for Cargo builds. These checks prevent source-version drift; they do not prove that a platform installer was signed, installed, restarted, or rolled back on a real supported machine.
