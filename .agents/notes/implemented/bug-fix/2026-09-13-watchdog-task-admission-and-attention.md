# Agent Note: WatchDog task admission and attention

Status: implemented

English | [中文](2026-09-13-watchdog-task-admission-and-attention.zh.md)

## Problem

A management task description can be lost when its panel unmounts. An uncertain prompt response can also leave a created Session without a clear retry destination, or create duplicate accepted work if a retry receives another identity. Managers need to distinguish a request awaiting their decision from an idle Session without treating execution status as proof of business completion.

## Decision

The [frontend navigation owner](../../../../frontends/dsh/src/navigation.ts) keeps the task goal, cadence and unconfirmed target for its lifetime. Switching settings, components or Sessions preserves the draft. A failed or uncertain submission reuses its allocated workspace and Session. Once a prompt is sent, an unconfirmed outcome locks the goal and cadence in both the form and navigation actions. Retry retains the exact prompt and DSH submission identity even if the UI locale changes; the existing Host admission owner deduplicates accepted requests. Opening the original Session permits inspection. Failures before prompt submission leave the draft editable. Confirmed acceptance clears and unlocks the draft. Navigation cancellation prevents late selection and a submission that has not begun; it does not withdraw an already submitted request.

The [WatchDog client](../../../../frontends/dsh/src/client.tsx) projects DSH's pending-interaction service. Approval, question and plan-review requests receive priority in the task list and an attention filter; opening one returns to its original Session. Running and idle remain execution states. The frontend does not infer business success or failure from Session text or maintain a second approval queue.

The [shell decision](../feature/2026-09-12-clawmaster-shell-over-dsh.md) retains workspace allocation and DSH runtime ownership. The [first-run tutorial](../feature/2026-09-13-watchdog-first-run-tutorial.md) separately owns the management introduction and its acknowledgement; reading it creates no task.

## Alternatives considered

**Keep the draft inside the panel.** Unmounting the panel discards it during normal navigation. The frontend lifetime already covers that user workflow.

**Allocate a new Session or request identity for every retry.** A transport failure does not prove rejection. Editing an uncertain request could enqueue another task while the original still runs. Locking its inputs and reusing DSH admission identity avoids that ambiguity without another deduplication service.

**Scan complete Sessions to derive errors or completion.** Existing pending interactions identify actionable user decisions directly. Idle status and arbitrary conversation text cannot certify a management outcome.

## Consequences

Draft retention covers panel navigation, not page reload or application exit. The frontend adds no durable draft store or business completion authority. Starting work remains explicit; rendering, filtering and navigation send no model request. Business-task starts submit the saved task brief through the selected Session with a durable request identity. Cadence instructions use the existing Schedule behavior and do not create an operating-system scheduler.

[Navigation tests](../../../../frontends/dsh/tests/navigation.test.mjs) cover retained drafts, editable failures before submission, locked uncertain inputs, unchanged retry identity across locale changes and cancellation. [Compiled component tests](../../../../frontends/dsh/tests/components-native.client.spec.mjs) exercise the registered WatchDog entry with pending interactions and record both languages. These are synthetic source and compiled-client checks; the desktop task owns final native interaction and real provider acceptance.
