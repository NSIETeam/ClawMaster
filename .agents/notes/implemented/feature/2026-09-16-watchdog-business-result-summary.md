# Agent Note: WatchDog home reports durable business attention

Status: implemented

English | [中文](2026-09-16-watchdog-business-result-summary.zh.md)

## Problem

The WatchDog home showed task details without a compact view of business work needing attention, making it harder to prioritize review, failures and overdue items.

## Decision

The WatchDog home displays a business attention summary above task details. The summary is derived from the bounded task page returned by the durable task service and counts overdue, waiting, awaiting-review and failed work. A task with overlapping signals contributes once to the attention total. The UI identifies the page-scoped count; it does not imply an unbounded database scan or organization-wide total. `taskAttentionSummary` is a browser-safe pure function with an explicit clock input, and the summary does not approve, dispatch or mutate tasks.

## Alternatives considered

**Count only one task status.** Waiting and overdue are independent signals that can apply to tasks in other lifecycle states, so a single-status count would omit work needing attention.

**Add overlapping category counts into one total.** One task can be both overdue and waiting or awaiting review; summing categories would count that task multiple times.

**Query the full task database for a global total.** The home uses the existing bounded task-page response; an additional unbounded query would duplicate data access and could imply completeness the page does not provide.

## Consequences

The summary helps prioritize loaded tasks while remaining read-only and page-scoped. Tasks outside the loaded page do not contribute, and the view is not an organization-wide workload report.
