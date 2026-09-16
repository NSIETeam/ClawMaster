---
description: "Reference for measuring synthetic ClawMaster enterprise storage capacity without accessing user data."
---

# Enterprise capacity diagnostic

English | [中文](README.zh.md)

## Summary

[The diagnostic](enterprise.perf.ts) measures the production SQLite store through a compiled adapter in fresh Node processes. It creates synthetic databases, records all samples and removes its temporary artifacts and data. It does not open the user's workspace. This is a maintainer reference, not an installed desktop benchmark or a required CI timing gate.

## Table of Contents

- [Run](#run)
- [Measurements](#measurements)
- [Interpretation](#interpretation)

<a id="run"></a>
## Run

Install the root and frontend dependencies from their lockfiles, then run from the repository root while other owned builds and benchmarks are idle:

```sh
node --import tsx/esm frontends/dsh/benchmarks/enterprise.perf.ts --output /tmp/clawmaster-capacity.json
```

The defaults are 100, 1,000 and 10,000 records per collection with five independent process samples per tier. `--tiers 100,1000` and `--samples 3` select shorter diagnostics. Each count must be between 1 and 10,000; samples must be between 2 and 20. Each worker has a two-minute timeout. The TypeScript loader belongs only to orchestration; measured workers run compiled JavaScript under plain Node with `NODE_OPTIONS` removed.

<a id="measurements"></a>
## Measurements

Each tier has the same number of customers, inventory items and one-line draft orders, plus five audit entries per record count. Twenty companies and ten suppliers create repeated search terms. Seeding uses the production receipt command API. Each sample receives a copy of the closed seed database in a private temporary directory.

| Operation | Timed completion |
| --- | --- |
| `open` | Store initialization and validation; excludes module imports and process startup |
| `list`, `search` | First customer page with at most 50 records and a 64 KiB byte budget |
| `auditTail` | Last 50 audit records using an offset query |
| `saveReceipt` | One existing customer update and its serialized command receipt |
| `snapshot` | Complete validated state and audit history serialized to JSON |
| `backup` | Restore-capable backup serialized to JSON |
| `restore` | Atomic restore and returned snapshot serialized to JSON |

The report includes every elapsed-time sample, nearest-rank p50/p95, response bytes, RSS before/after each operation, heap use after each operation and process peak RSS. GC runs before each operation. The result object and its JSON text remain reachable at the memory observation; the backup remains reachable during restore. An immediate callback records the largest event-loop scheduling gap across the operation, including its final synchronous block. This measures Node scheduling, not browser input latency.

<a id="interpretation"></a>
## Interpretation

The report records the checkout commit, dirty status, worker digest, Node version, architecture and machine memory. The compiled adapter uses the checkout's installed external packages. Keep the report with its exact checkout and lockfiles. Filesystem caches are not flushed; fresh processes do not imply cold disks. p95 from five samples is the slowest sample, not a population estimate.

List and receipt size can stay bounded while full snapshot, startup validation, backup and restore costs grow with history. Compare the same fixture dimensions and operation endpoint when investigating a regression. Do not remove validation or history to improve a number. See the [measurement decision](../../../.agents/notes/implemented/testing/2026-09-16-clawmaster-enterprise-capacity.md) for acceptance limits and exclusions.
