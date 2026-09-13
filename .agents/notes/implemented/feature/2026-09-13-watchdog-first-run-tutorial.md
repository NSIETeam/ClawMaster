# Agent Note: WatchDog first-run tutorial

Status: implemented

English | [中文](2026-09-13-watchdog-first-run-tutorial.zh.md)

## Problem

First entry must teach enterprise management: scope, responsibilities, business evidence, recurring checks and corrective action. Acknowledgement must survive changing desktop ports without implying verified model or IM readiness.

## Decision

The [WatchDog frontend](../../../../frontends/dsh/README.md#first-run-tutorial) owns five steps around this week's customer follow-ups and delivery risks. Users define scope, write responsibilities and acceptance criteria, inspect CRM/ERP and supplied files, choose cadence and review approvals, then verify findings and request corrective action. Responsibilities are task-description text; delivery commitments require supplied evidence. The guide claims no assignment dashboard or structured delivery tracking.

DSH's existing `settings.onboarding` coordinator waits for settings, Sessions and Workspaces and requires no user history. Settings provides replay. ClawMaster omits the Models plugin's two automatic welcomes but retains provider editing; official builds retain their sequence. Explicit skip and finish write version 1 to `acknowledgedVersion` in `clawmaster-watchdog-onboarding`; newer versions remain acknowledged. Settings owns persistence, conflicts and recovery. Unconfirmed writes keep the guide open for retry. Remote memory mode acknowledges only within the coordinator's lifetime.

The primary action selects WatchDog through the public layout API. Auxiliary Models and IM actions follow it and use `openSection`. Reading and navigation create no Sessions, submit no prompts, schedule no reminders and send no external messages. Recurring checks require the app and Session to remain active; an idle task does not prove completion.

The [ClawMaster shell decision](2026-09-12-clawmaster-shell-over-dsh.md) separately owns runtime reuse, lazy workspaces and enterprise components.

## Alternatives considered

**Browser localStorage.** Acknowledgement depends on the temporary origin and lacks shared revision handling.

**A separate backend or automatic demonstration.** These duplicate settings or spend model usage before the user submits work.

**Repeated welcome sequences.** They interrupt the first task; model configuration has an explicit destination.

## Consequences

Completion records dismissal only. Compiled-client acceptance records both languages and covers new/existing users, rejected writes, replay, disposal during persistence and management navigation without task creation. Native desktop acceptance owns WebKit focus, responsive layout and acknowledgement across a real restart.
