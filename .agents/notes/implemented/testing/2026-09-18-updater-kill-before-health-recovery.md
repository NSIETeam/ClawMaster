# Agent Note: Verify updater recovery after process termination

Status: implemented

English | [中文](2026-09-18-updater-kill-before-health-recovery.zh.md)

## Problem

Updater selection and successful Host activation are separate events. A process can terminate after the profile selects the new updater but before the updater sends its loaded-health receipt. Modeling journal states in one process does not prove that a process restart can recover that interval.

## Decision

The maintenance test starts a separate Node process, lets it apply the approved updater selection, waits for its durable `awaiting-health` result, and kills it with `SIGKILL` before any health confirmation. A fresh maintenance call must restore the previous profile and preserve a `rolled-back` operation record. A POSIX test also runs maintenance under a zero-byte file-size quota: failure to write the transition journal must preserve its `staged` record and the prior profile, and remove the temporary file. The README states this exact coverage and its limits.

## Alternatives considered

**Only write a synthetic `switching` journal in the test process.** That verifies state handling but does not prove that a killed process leaves durable state which a later process can recover. The existing state-based tests remain useful for the atomic replacement's before/after cases, while the subprocess test covers real process termination after selection.

**Treat a file-size quota failure as full-volume or native-installer evidence.** The quota tests an atomic write failure with `EFBIG`, not volume-wide `ENOSPC`; neither test covers a kill during rename or a real installed package rollback.

## Consequences

The selected-but-unconfirmed startup path has process-level recovery evidence, and a failed transition-journal atomic write preserves the staged operation and live profile under a constrained file-size quota. Volume-wide `ENOSPC` during profile replacement and interruption of actual macOS, Windows, or Linux native installation still require platform-specific fault injection and installed-product acceptance.
