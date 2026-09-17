# Agent Note: WatchDog schedule restart recovery

Status: implemented

English | [中文](2026-09-17-watchdog-schedule-restart-recovery.zh.md)

## Problem

Store-level cursor tests do not prove that a restarted Host can safely turn elapsed schedule time into one persisted DSH message.

## Decision

The Host scenario in [`watchdog-schedule-host.scenario.mjs`](../../../../frontends/dsh/tests/watchdog-schedule-host.scenario.mjs) closes the real SQLite connection and DSH schedule runtime, reopens the same ledger, and advances the injected wall clock by fifteen minutes. It verifies that coalescing creates only the latest missed fixed-rate occurrence, that restart does not grant approval, and that an explicit human approval allows the real DSH Jobs and AgentLoop path to persist one occurrence. A repeated scheduler tick does not enqueue it again.

This test proves application-level restart recovery with a synthetic model and a controlled clock. It does not prove that an installed desktop wakes after OS sleep, that an external server service stays running, or that an operator receives an alert while the Host is unavailable. Those outcomes require the target OS, service manager, and independent alert destination.

## Alternatives considered

**Test only the occurrence store.** Store tests prove cursor and lease transitions but do not exercise DSH Jobs, AgentLoop, Session persistence, or the approval boundary after Host restart.

**Claim installed desktop recovery from the controlled-clock test.** The test does not suspend the host or exercise its power management, so that claim would exceed its evidence.

## Consequences

The acceptance scenario covers the Host lifecycle and exactly-once inbox admission boundary without model API access. Installed desktop sleep/resume and server service management remain separate acceptance items.
