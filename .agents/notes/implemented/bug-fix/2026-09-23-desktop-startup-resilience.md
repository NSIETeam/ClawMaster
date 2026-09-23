# Agent Note: Keep desktop startup and integrations usable through degraded state

Status: implemented

English | [中文](2026-09-23-desktop-startup-resilience.zh.md)

## Problem

Desktop startup repaired every DSH profile and re-resolved dependencies even when only the web Host was needed. A stale optional profile or a registry outage could therefore delay or block launch. The first session projection could also clear the persisted selection before the list arrived, and the RPA plugin could be withheld entirely when the approval service was temporarily unavailable.

## Decision

The desktop repairs only `profiles/web`, uses the bundled lockfile and bounded offline-first pnpm retries, and leaves unrelated profiles for explicit plugin maintenance. IM defaults now declare a durable retry schedule and health interval. Session selection is cleared only after a ready list proves that the selected id is absent. RPA injects only the tool registry; read-only inspection remains available during approval degradation, while every write action still requires the existing approval capability and fails closed without it.

The Tauri shell continues to use the internal DSH web Host because it supplies the frontend runtime. It always starts that Host with `--no-open`; no external Web UI is opened as part of desktop startup.

## Alternatives considered

**Install every profile at startup.** This preserves a clean-looking profile tree but makes unrelated optional state a launch dependency and repeats network work.

**Make approval optional for every RPA action.** This would make write actions callable without an independent grant and violate the existing fail-closed safety rule.

**Remove the DSH web Host.** The Tauri frontend is served by that internal Host, so removing it would remove the application runtime rather than remove the external browser path.

## Consequences

First launch no longer downloads dependencies for unrelated profiles or re-resolves the shipped graph. Offline/local-store installs can complete with bounded retries. A restart preserves the selected session while the list is pending. IM supervisors reconcile transient disconnects without a manual reconnect. RPA discovery and read-only calls remain usable in degraded approval state; desktop-changing calls retain explicit authorization.

## Verification

The session-controller client suites cover pending-list selection preservation and Host reconnect recovery. Desktop defaults and release workflow tests pass, including the IM retry configuration and strict internal Host launch. Rust profile-repair tests and the RPA host tests cover the narrowed startup and optional approval dependency.
