# Agent Note: Recover failed session windows after a Host reconnect

Status: implemented

English | [中文](2026-09-23-session-recovery-after-offline.zh.md)

## Problem

A session window opened while the desktop Host was unreachable could finish its initial journal request with a `gateway/internal` error. Later Host recovery refreshed the list and existing live streams, but the failed cold window had no stream generation left to reconnect, so the selected conversation stayed in an error state until the application was manually repaired.

## Decision

When a new Host connection generation is established, the Session Manager retries only resident Session windows whose opening state is `error` with a `gateway/internal` failure. The retry uses the existing generation-guarded `resync()` path, while already-open windows keep their independent stream recovery. Protocol and domain failures such as `session/not-found` remain visible and are not retried automatically.

The isolated browser render gate uploads its proof from the runner temporary directory where the verification script writes it, and missing proof is now a hard workflow failure.

## Alternatives considered

**Resync every resident Session after every reconnect.** This adds unnecessary history reads and can disturb healthy live windows whose own streams already recover.

**Retry every Session error.** Domain failures would be hidden by repeated requests and could turn a permanent removal into an endless recovery loop.

**Keep render evidence optional.** A green browser assertion without its retained screenshot makes the published acceptance record incomplete and lets a path mistake go unnoticed.

## Consequences

Sessions that failed solely because the Host carrier was unavailable recover on the next successful generation without requiring a manual refresh. Other terminal failures remain explicit. GitHub's isolated-install job now fails if the browser proof cannot be retained, so a successful job includes an uploadable render artifact.

## Verification

The Session Controller client suite includes a regression that fails the first history load, establishes a new generation, and verifies the same Session opens successfully on the second load. The desktop workflow regression checks the temporary-directory upload paths and strict missing-file policy.
