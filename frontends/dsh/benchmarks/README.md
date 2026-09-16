---
description: "Reference for measuring synthetic ClawMaster enterprise storage capacity without accessing user data."
---

# Enterprise capacity diagnostic

English | [中文](README.zh.md)

## Summary

[The diagnostic](enterprise.perf.ts) measures production SQLite startup and registered HTTP handlers through a compiled adapter in fresh Node processes. It creates synthetic databases, records all samples and removes its temporary artifacts and data. It does not open the user's workspace. This is a maintainer reference, not an installed desktop benchmark or a required CI timing gate.

## Table of Contents

- [Run](#run)
- [Measurements](#measurements)
- [Interpretation](#interpretation)
- [Measured workload](#measured-workload)

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
| `overview` | HTTP versions, counts and configured limits |
| `list`, `search` | First customer page with at most 50 records and the default 256 KiB byte budget |
| `auditTail` | Last 50 audit records using the version-checked revision range |
| `saveReceipt` | One existing customer update and its serialized command receipt |
| `backup` | Restore-capable backup serialized to JSON |
| `restore` | Atomic restore and returned snapshot serialized to JSON |

The report includes every elapsed-time sample, nearest-rank p50/p95, response bytes, RSS before/after each operation, heap use and cumulative process peak RSS at each operation. GC runs before each operation. HTTP measurements include request parsing, handler execution, response serialization and client JSON decoding; the authenticated DSH carrier and network are excluded. The result object and its JSON text remain reachable at the memory observation; the backup remains reachable during restore. An immediate callback records the largest event-loop scheduling gap across the operation, including its final synchronous block. This measures Node scheduling, not browser input latency.

<a id="interpretation"></a>
## Interpretation

The report records the checkout commit, dirty status, worker digest, Node version, architecture and machine memory. The compiled adapter uses the checkout's installed external packages. Keep the report with its exact checkout and lockfiles. Filesystem caches are not flushed; fresh processes do not imply cold disks. p95 from five samples is the slowest sample, not a population estimate.

List and receipt size can stay bounded while startup validation, backup and restore costs grow with history. Compare the same fixture dimensions and operation endpoint when investigating a regression. Do not remove validation or history to improve a number. See the [measurement decision](../../../.agents/notes/implemented/testing/2026-09-16-clawmaster-enterprise-capacity.md) for acceptance limits and exclusions.

<a id="measured-workload"></a>
## Measured workload

The [2026-09-16 raw report](2026-09-16-paged-enterprise.json) contains three samples per tier on a shared macOS arm64 development machine: 6 logical CPUs, 8 GiB RAM, Node 24.20.0. The worker digest identifies the compiled source; the report marks the checkout dirty because these changes were under verification. p95 is the largest of three observations. Values below are milliseconds as p50/p95, not release guarantees.

| Operation | 100 records / 500 audit | 1,000 records / 5,000 audit | 10,000 records / 50,000 audit |
| --- | --- | --- | --- |
| Open and full validation | 25.1 / 29.8 | 132.1 / 132.3 | 1021.4 / 1060.1 |
| Overview | 34.5 / 37.4 | 31.6 / 35.8 | 32.7 / 34.7 |
| First page | 6.5 / 6.9 | 5.6 / 6.6 | 6.0 / 6.9 |
| Search | 1.5 / 2.7 | 8.2 / 8.9 | 19.7 / 21.9 |
| Audit tail | 6.4 / 7.1 | 5.3 / 5.5 | 5.2 / 5.4 |
| Save receipt | 3.4 / 3.4 | 2.9 / 4.1 | 2.8 / 3.0 |
| Explicit backup | 28.2 / 30.5 | 175.8 / 178.5 | 1848.3 / 2193.0 |
| Explicit restore | 63.8 / 64.4 | 378.3 / 386.1 | 4726.8 / 5540.2 |

First-page responses are 9,016 / 9,018 / 9,020 bytes; save receipts are 160 / 162 / 164 bytes. Cumulative peak RSS through ordinary save is 82.9 / 95.2 / 112.2 MiB, rising to 102.9 / 249.3 / 771.1 MiB with explicit backup and restore. The largest restore blocks Node scheduling for approximately 5.54 seconds. These measurements establish bounded ordinary response size for this dataset; they do not establish safe whole-store backup at arbitrary scale, low-memory desktop acceptance or a hard process-tree limit. The configured page limits and explicit oversized-record errors remain the enforceable capacity controls.
