# Agent Note: Windows process-tree RSS observation

Status: implemented

English | [中文](2026-09-16-watchdog-windows-process-tree-rss.zh.md)

## Problem

WatchDog's process-tree budget needs a resident-memory observation on Windows. The Host RSS value alone cannot account for child processes started by tools, while a partial native read could under-report the tree.

## Decision

The local subprocess provider exposes Windows process-tree RSS through the existing Toolhelp32 snapshot and a PSAPI `GetProcessMemoryInfo` working-set read. The aggregation follows parent links from the Host PID and includes the Host and every observed descendant once.

The aggregation is fail-closed. An absent root, an unreadable process, an invalid or unsafe byte count, and native binding failure produce an unavailable observation. Runtime governance keeps the independent Host RSS budget when the tree observation is unavailable; it never substitutes a whole-machine value or a partial tree sum.

The ClawMaster frontend declares the provider dependency and tolerates an older provider export by retaining the unavailable result. The desktop workspace lock resolves the provider from the bundled DSH source, so the release build receives the native implementation without a shell command or user-installed monitoring utility.

## Alternatives considered

Keeping Windows unsupported would leave the production resource budget blind to child processes. Reading `tasklist`, PowerShell output, or a whole-machine counter would add an external dependency or misrepresent the Host tree. Reusing the existing native provider keeps process identity and memory observations on one Win32 implementation.

## Consequences

Protected Windows processes may make the process-tree budget temporarily unavailable. This preserves a truthful status and still enforces the Host budget and heavy-operation concurrency limit. A real Windows runner remains required for validating the Koffi ABI and protected-process behavior; non-Windows tests cover the aggregation and all failure branches.

## Verification

`pnpm exec vitest run packages/subprocess/subprocess-local/tests/windows-inspector.spec.ts` passes 13 tests with the platform-native suite skipped off Windows. `pnpm exec tsc -p packages/subprocess/subprocess-local/tsconfig.json --noEmit`, `npm run typecheck --prefix frontends/dsh`, and `npm run build --prefix frontends/dsh` pass. The frontend package lock resolves `@deepseek-ai/dsh-subprocess-local@0.1.5-rc.2`; desktop's trimmed lock resolves the workspace provider.
