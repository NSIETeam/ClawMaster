# WatchDog home reports durable business attention

English | [中文](2026-09-16-watchdog-business-result-summary.zh.md)

The WatchDog home now shows a business outcome summary above task details. It is derived from the bounded task page returned by the durable task service, and counts overdue, waiting, awaiting-review, and failed work. A task with overlapping signals contributes once to the attention total. The copy states that the counts are page-scoped, so the view does not imply an unbounded database scan or a complete organization-wide total.

The summary is presentation-only. It does not approve, dispatch, or mutate a task. `taskAttentionSummary` is a browser-safe pure function with an explicit clock parameter so the classification is deterministic in tests.
