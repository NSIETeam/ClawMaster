# Agent Note: Enterprise capacity measurements use isolated compiled workers

Status: implemented

English | [中文](2026-09-16-clawmaster-enterprise-capacity.zh.md)

## Problem

Functional enterprise tests establish record and transaction behavior but do not quantify growth in full-state responses, audit reads or startup validation. A bounded query does not establish that its caller avoids a full snapshot elsewhere.

## Decision

The [owner-local diagnostic](../../../../frontends/dsh/benchmarks/README.md) compiles the production store with the same external-package policy as the frontend Host build. Fresh plain Node processes read private copies of synthetic databases; no user workspace, credentials or model calls enter the workload. Fixture construction and module imports are outside timing. The report identifies its source and compiled adapter as diagnostic evidence rather than an installed release.

The three default tiers hold 100, 1,000 and 10,000 records in each business collection with five times that many audit entries. A single SQLite transaction inserts deterministic records and corresponding audit rows, then production initialization reopens the database and validates record schemas, foreign keys, contiguous audit history and responsibility history before sampling. This keeps fixture preparation outside endpoint timing without treating unchecked rows as production data. Each sampled endpoint includes serialization where a response exists. GC precedes measurements; result objects remain reachable at the memory observation. Restore retains its input backup. The event-loop probe includes the final synchronous stall, while the report expressly excludes browser input and painting.

## Alternatives considered

**Run every production command to prepare the fixture.** This exercises command throughput rather than the measured read, backup and restore paths; opening the resulting database through production initialization still verifies the durable business and audit data used by the measurements.

**Require a fixed time budget immediately.** A local timing run on a shared development machine does not establish a stable CI noise floor. This diagnostic reports all samples without a performance-pass verdict. The existing [required benchmark lane](2026-09-04-session-open-performance-gate.md) remains the owner of calibrated CI budgets.

## Consequences

Measurements distinguish bounded list and receipt results from whole-store endpoints and reveal their absolute byte, latency and memory costs. The worker asserts fixture counts, a committed edit and a completed restore. A two-minute child timeout bounds failures and private directories are cleaned after success or error. The fixture does not measure production command throughput. These checks do not establish HTTP access control, browser responsiveness, an installed package's memory limit or support for arbitrary enterprise dataset sizes.

Any optimization still needs owning behavior tests, a measured before/after comparison at identical completion conditions and a negative control. The diagnostic alone does not resolve full-snapshot hot paths, historical audit paging or streaming backup requirements.
