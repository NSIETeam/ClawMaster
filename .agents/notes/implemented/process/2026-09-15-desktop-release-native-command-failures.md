# Agent Note: Fail desktop release steps at the first native command error

Status: implemented

English | [中文](2026-09-15-desktop-release-native-command-failures.zh.md)

## Problem

PowerShell's default error preference does not stop a script when a native executable exits unsuccessfully. GitHub's final `$LASTEXITCODE` check can report success after a later command replaces that value. A failed component test must prevent subsequent build or publication work in the same step.

## Decision

The [desktop release workflow](../../../../.github/workflows/desktop-release.yml) uses native PowerShell for every Windows-reachable build step. Each PowerShell step, including publication checks, requires version 7.4 or later and explicitly sets `$ErrorActionPreference = 'Stop'` and `$PSNativeCommandUseErrorActionPreference = $true` before executing commands. Each step owns these settings because Actions starts a separate shell for each step. macOS/Linux-only Bash steps retain their shell's failure handling.

## Alternatives considered

**Check only the final exit code.** This loses an earlier failure when a later command succeeds.

**Add a manual exit-code check after every native invocation.** This works but requires every added command to include its own check. The shared PowerShell behavior covers new commands without a custom execution wrapper.

## Consequences

Every native nonzero exit is fatal unless an explicitly scoped operation handles a documented non-error exit code. The workflow does not treat diagnostic output on stderr alone as a command failure.

The [workflow regression](../../../../apps/desktop-tauri/scripts/release-workflow.test.mjs) executes the committed command sequences and preferences with isolated native command substitutes. A failing call must stop later calls and produce a nonzero shell exit; disabling the preference must reproduce the misleading successful exit. Hosted CI requires PowerShell for this check. These synthetic command failures establish shell propagation, not product behavior or native Windows installation acceptance.
