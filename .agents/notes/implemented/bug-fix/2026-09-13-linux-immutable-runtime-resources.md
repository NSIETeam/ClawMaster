# Agent Note: Immutable Linux runtime resources

Status: implemented

English | [中文](2026-09-13-linux-immutable-runtime-resources.zh.md)

## Problem

Linuxdeploy recursively inspects ELF files under an AppImage's `usr/lib`. The desktop runtime includes a musl Node addon that glibc `ldd` cannot inspect. Successful inspection also schedules RPATH changes, so keeping native runtime resources in that directory can change bytes covered by the runtime manifest.

## Decision

Linux AppImage and Debian packages place the complete prepared runtime at `usr/share/ClawMaster/harness-source` through Tauri's package-specific `files` mappings. The Linux configuration removes only the global harness resource mapping using Tauri's JSON Merge Patch. The runtime derives the shared-data directory from Tauri's resource directory and requires its bundle manifest. Linux development builds can read the prepared source directory anchored to their compile-time Cargo manifest directory.

Both libc addon variants, the static Landlock launcher, and the full DSH source and plugin payload remain present. The content hash continues to identify the immutable runtime, independently of its package location. [Source provisioning](../feature/2026-08-14-cross-platform-desktop-source-provisioning.md) still owns the writable installation and supported Host launch.

## Alternatives considered

**Pass `--exclude-library`.** Linuxdeploy applies that option when copying dependency libraries, after the existing-resource scan has selected each ELF file. It does not exclude the embedded addon from inspection.

**Remove the musl addon.** That avoids one incompatible inspection but leaves other native resources subject to RPATH changes. Relocating the complete runtime preserves its bytes and native capabilities.

**Relax the payload hash check.** That would hide package-time modification and weaken the source-to-installation evidence.

## Consequences

Linux package mappings and runtime path resolution must agree. The artifact verifier checks extracted AppImage and Debian payloads against the original prepared manifest and hash, requires both native addon variants and an executable sandbox launcher, and rejects a second runtime under `usr/lib`. Production installation and authenticated Host restart tests run against copies of those extracted payloads; validation of the prepared directory alone does not establish installation integrity.
