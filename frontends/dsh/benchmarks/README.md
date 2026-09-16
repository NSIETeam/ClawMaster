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
| `backup` | Worker export streamed into a downloaded Blob |
| `prepareBackup` | Raw Blob upload, worker validation and small review response |
| `restore` | Worker transaction, authority checks and serialized durable receipt |

The report includes every elapsed-time sample, nearest-rank p50/p95, response bytes, RSS before/after each operation, heap use and Host-only and child-process peak RSS, plus the sum of their maxima as a conservative bound. GC runs before each operation. HTTP measurements include request bodies, handlers, serialization and client decoding; backup download remains a Blob and the authenticated DSH carrier and network are excluded. The harness retains the downloaded Blob during preparation and restoration, so its memory also includes synthetic browser-side storage inside the measured process. An immediate callback records the largest Host event-loop scheduling gap, including the final synchronous block. This measures Node scheduling, not browser input latency.

<a id="interpretation"></a>
## Interpretation

The report records the checkout commit, dirty status, adapter and backup-worker digests, Node version, architecture and machine memory. The compiled adapter uses the checkout's installed external packages. Keep the report with its exact checkout and lockfiles. Filesystem caches are not flushed; fresh processes do not imply cold disks. p95 from five samples is the slowest sample, not a population estimate.

List and receipt size can stay bounded while startup validation, backup and restore costs grow with history. Compare the same fixture dimensions and operation endpoint when investigating a regression. Do not remove validation or history to improve a number. See the [measurement decision](../../../.agents/notes/implemented/testing/2026-09-16-clawmaster-enterprise-capacity.md) for acceptance limits and exclusions.

<a id="measured-workload"></a>
## Measured workload

The [worker-backup report](2026-09-16-worker-backups.json) contains three samples per tier on a shared macOS arm64 machine: 6 logical CPUs, 8 GiB RAM, Node 24.20.0. Both compiled artifacts have SHA-256 records; the checkout is marked dirty during verification. p95 is the largest of three observations. Values below are milliseconds as p50/p95, not release guarantees. The [whole-snapshot baseline](2026-09-16-paged-enterprise.json) retains its original observations.

| Operation | 100 records / 500 audit | 1,000 records / 5,000 audit | 10,000 records / 50,000 audit |
| --- | --- | --- | --- |
| Open and full validation | 18.2 / 18.9 | 96.7 / 99.7 | 842.9 / 1041.0 |
| Overview | 23.0 / 24.8 | 24.8 / 25.4 | 25.7 / 26.3 |
| First page | 3.3 / 3.5 | 3.7 / 3.8 | 4.2 / 5.3 |
| Search | 1.1 / 1.4 | 5.5 / 6.2 | 16.6 / 17.1 |
| Audit tail | 3.5 / 3.6 | 3.8 / 4.4 | 4.1 / 5.8 |
| Save receipt | 1.9 / 2.2 | 2.4 / 2.6 | 2.5 / 3.1 |
| Download backup | 89.8 / 92.8 | 254.0 / 274.0 | 1847.5 / 1967.9 |
| Upload and validate | 83.0 / 83.7 | 182.6 / 215.2 | 1066.6 / 1069.4 |
| Confirm restore | 88.5 / 94.1 | 214.2 / 277.8 | 1523.9 / 1568.8 |

Restore receipts are 144 / 145 / 146 bytes; preparation responses are 267 / 272 / 277 bytes. Exported files are approximately 0.4 / 4.1 / 41.4 MB. Host-only peak RSS is 89.8 / 109.5 / 228.7 MiB; child peaks are reported separately for each operation. The greatest sum of Host and child peaks is 168.5 / 233.2 / 551.0 MiB: a conservative upper bound, not a simultaneously sampled peak. At the largest tier, restore has a 7.0 ms maximum Host scheduling gap and export 13.0 ms. The whole-snapshot baseline reached 771.1 MiB and a 5.54-second restore gap. Process startup increases small-file latency; preparation and confirmation are separate measured operations. Configured file/heap limits can refuse larger imports, and native allocations remain outside V8 heap caps. A 32 MiB heap failure is isolated to the private executor; the regression verifies that the Host and database remain usable. These results do not establish installed-desktop acceptance.
