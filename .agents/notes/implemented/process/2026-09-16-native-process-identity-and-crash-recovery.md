# Agent Note: Bind native acceptance to process creation identity

Status: implemented

English | [中文](2026-09-16-native-process-identity-and-crash-recovery.zh.md)

## Problem

Native acceptance previously retained numeric PIDs and executable paths, but a report did not show that those identities remained unchanged from launch through readiness and evidence capture. A reused PID or replaced executable could therefore be mistaken for the process that the collector started.

## Decision

The macOS and Windows collectors retain executable paths and process creation identities at launch, readiness and final evidence capture. The verifier rejects a report when a PID, executable path, parent or creation identity changes between those observations. Windows keeps the owned process handle during teardown; macOS uses identity-aware observation and reaping. These checks prevent cleanup from acting on a reused PID.

The desktop's crash-recovery `host.pid` record now stores a platform process-creation token alongside the PID and Node image. Startup reclaims a stale Host only when both the executable path and creation token still match; an old two-line record is left alone for review rather than risking a reused PID.

The desktop runtime state already publishes a new run id on each successful launch and checks that id before marking a run stopped. Native acceptance retains failed observations after an interrupted launch, while a later launch writes a successor record through the same desktop-owned state path. A native crash or device restart still requires real platform evidence; unit tests and normal-close runs cannot establish that result.

## Consequences

Cross-platform native reports now carry enough process identity to detect replacement during the observed run. This strengthens the install and restart lanes without treating a process probe as publisher signature or device evidence. Developer ID notarization, Authenticode, Android coverage and real-device crash recovery remain external prerequisites for a complete release matrix.
