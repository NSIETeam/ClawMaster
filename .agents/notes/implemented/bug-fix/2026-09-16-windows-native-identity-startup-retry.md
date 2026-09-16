# Agent Note: Windows native launch identity readiness

Status: implemented

English | [中文](2026-09-16-windows-native-identity-startup-retry.zh.md)

## Problem

The Windows native acceptance collector could reject a valid second desktop launch before readiness because `Process.Start()` returned before `StartTime` or `MainModule.FileName` became readable.

## Decision

The collector polls the owned `Diagnostics.Process` for up to ten seconds before declaring its identity unavailable. It continues to use the process handle returned by `Process.Start()`, stops polling when that process exits, and keeps the existing PID, creation-time and executable-path checks for every readiness sample.

## Alternatives considered

Looking up the executable by name or accepting a PID without its creation time would hide replacement and PID reuse. Increasing the global startup timeout would not address the immediate identity race and would delay genuine failures unnecessarily.

## Consequences

A transient Windows process metadata race no longer causes a false negative on the second launch. A process that exits before identity becomes readable still fails the acceptance run and is cleaned up through its owned handle.

## Verification

The change is limited to `verify-windows-native.ps1`. PowerShell execution is owned by the GitHub-hosted Windows release job; the current macOS checkout has no `pwsh`, so the real two-launch acceptance remains pending that job. The existing `windows-native-evidence` tests continue to validate the collected identity and relaunch evidence contract.
