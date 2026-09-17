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

The [93d05b1 candidate report](2026-09-17-candidate-93d05b.json) records three samples per tier on macOS arm64 with 6 logical CPUs, 8 GiB RAM and Node 24.20.0. It identifies a clean source commit and hashes both compiled artifacts. Each p95 is the largest of three observations, not a population estimate. Values are milliseconds as p50/p95. The run completed 100-record and 1,000-record tiers; the 10,000-record seed exceeded the existing 120-second worker deadline, so the required three-tier acceptance remains incomplete and no supported capacity tier is established.

| Operation | 100 records / 500 audit | 1,000 records / 5,000 audit | Response bytes, 100 / 1,000 |
| --- | --- | --- | --- |
| Open and full validation | 81.1 / 137.8 | 437.7 / 727.2 | — |
| Overview | 61.0 / 84.9 | 80.4 / 124.1 | 169 / 174 |
| First page | 12.3 / 14.5 | 13.2 / 27.7 | 9,016 / 9,018 |
| Search | 4.2 / 7.7 | 11.8 / 15.8 | 995 / 9,052 |
| Audit tail | 10.0 / 17.6 | 18.6 / 29.2 | 20,559 / 20,562 |
| Save receipt | 10.3 / 21.9 | 18.5 / 29.4 | 160 / 162 |
| Download backup | 401.2 / 422.2 | 950.1 / 3,358.8 | 405,127 / 4,091,334 |
| Upload and validate | 264.2 / 299.2 | 851.4 / 2,329.6 | 267 / 272 |
| Confirm restore | 495.0 / 498.0 | 4,362.6 / 7,566.9 | 144 / 145 |

The saved receipt stays effectively constant in size across these two tiers. Export files are about 0.4 MB and 4.1 MB. The greatest sum of Host and child peak RSS across measured operations is 181.7 MiB and 214.1 MiB; these are conservative sums of separately observed process peaks, not simultaneous measurements. This single local run reports diagnostic costs, not an acceptance budget or user-capacity promise. It excludes installation, authenticated DSH transport, browser input and painting, cold filesystem caches, and external applications. The [whole-snapshot baseline](2026-09-16-paged-enterprise.json) and [worker-backup report](2026-09-16-worker-backups.json) remain historical observations from older dirty checkouts and are not evidence for this candidate.

An isolated 10,000-record run on this commit also timed out at the configured two-minute worker deadline. Fixture seeding uses production receipt commands and is outside operation timing; the timeout is therefore a diagnostic preparation limit, not a measured operation latency. Do not raise it to turn the unfinished tier into a capacity claim.

### Historical report

The following 2026-09-16 table belongs to the older dirty checkout recorded in the linked report. It is retained for historical comparison only; it does not complete the 93d05b1 candidate's three-tier acceptance.

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
