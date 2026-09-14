# Agent Note: Bind desktop compatibility tests to prepared source

Status: implemented

English | [中文](2026-09-14-desktop-compatibility-source-binding.zh.md)

## Problem

An installed plugin tree can retain earlier DSH artifacts while the checkout changes. Selecting that tree solely because it exists lets a compatibility test pass without checking the edited runtime. Manually retained pristine package directories also make the check dependent on another developer's temporary files.

## Decision

The desktop `test:compat` command verifies current prepared-build provenance and the uninstalled bundle digest before acquiring dependencies. It copies the verified payload to a private temporary directory, installs frozen dependencies without lifecycle scripts, and checks pinned registry archives against the reviewed package hashes before extraction. Tests receive explicit artifact directories; the routing test has no implicit preference for a packaged tree. The runner rechecks source provenance after the tests and removes its own temporary tree on completion or failure.

The lockfile is generated from the final trimmed manifests and includes every frontend and the system-prompt workspace. Lock checks and a real fresh-home boot jointly verify component discovery and tool registration. Desktop runtime tests run in the platform matrix; generic PATH fixtures use host-valid paths, while copying real Windows files into WSL mounts is tested on Windows only.

## Alternatives considered

**Prefer any existing bundled runtime.** Its existence proves neither freshness nor a match with edited source.

**Reuse undocumented temporary package directories.** Their contents and availability cannot support a repeatable acceptance command.

## Consequences

Compatibility testing requires preparation, network access, pnpm and tar. The result covers package installation and scripted runtime compatibility, not live memory capture/retrieval, IM delivery, or native installation. Archive substitution has a negative-control test in `test:bundle`; existing provenance tests reject changed source and replaced artifacts.
