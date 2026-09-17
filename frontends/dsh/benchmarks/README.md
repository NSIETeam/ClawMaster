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

Each tier has the same number of customers, inventory items and one-line draft orders, plus five audit entries per record count. Twenty companies and ten suppliers create repeated search terms. The diagnostic inserts deterministic rows and matching audit history in one SQLite transaction, then reopens the database through production initialization before sampling; schema, foreign keys, record formats, audit continuity and responsibility history are validated. Each sample receives a copy of the closed seed database in a private temporary directory.

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

The report records the checkout commit, dirty status, adapter and backup-worker digests, Node version, architecture and machine memory. The compiled adapter uses the checkout's installed external packages. Keep the report with its exact checkout and lockfiles. Filesystem caches are not flushed; fresh processes do not imply cold disks. The reported p95 is the slowest observed sample, not a population estimate.

List and receipt size can stay bounded while startup validation, backup and restore costs grow with history. Compare the same fixture dimensions and operation endpoint when investigating a regression. Do not remove validation or history to improve a number. See the [measurement decision](../../../.agents/notes/implemented/testing/2026-09-16-clawmaster-enterprise-capacity.md) for acceptance limits and exclusions.

<a id="measured-workload"></a>
## Measured workload

The [0.2.4 candidate report](2026-09-18-candidate-b50d31.json) records three samples per tier on an Apple Silicon Mac with 6 logical CPUs, 8 GiB RAM and Node 24.20.0. It identifies clean source commit `b50d31a3d2cdb49a35282c512b2482b24d418958` and hashes the compiled adapter and backup worker. Each p95 is the largest of three observations, not a population estimate. Values are milliseconds as p50/p95; all three tiers completed with 100/500, 1,000/5,000 and 10,000/50,000 business records/audit entries.

| Operation | 100 records / 500 audit | 1,000 records / 5,000 audit | 10,000 records / 50,000 audit | Response bytes, 100 / 1,000 / 10,000 |
| --- | --- | --- | --- | --- |
| Open and full validation | 19.0 / 20.0 | 114.1 / 121.0 | 1136.8 / 1152.8 | — |
| Overview | 18.8 / 19.4 | 20.2 / 20.5 | 24.9 / 26.1 | 169 / 174 / 179 |
| First page | 3.1 / 3.3 | 3.2 / 3.2 | 3.6 / 3.7 | 9,016 / 9,018 / 9,020 |
| Search | 1.0 / 1.1 | 3.1 / 3.3 | 5.3 / 6.0 | 995 / 9,052 / 9,052 |
| Audit tail | 3.1 / 3.2 | 3.2 / 3.5 | 3.8 / 4.0 | 20,559 / 20,562 / 20,565 |
| Save receipt | 3.5 / 3.9 | 4.0 / 4.7 | 4.5 / 4.6 | 160 / 162 / 164 |
| Download backup | 85.4 / 90.8 | 216.7 / 233.0 | 1798.2 / 1995.4 | 405,127 / 4,091,334 / 41,394,341 |
| Upload and validate | 81.3 / 82.4 | 181.3 / 185.8 | 1093.2 / 1249.8 | 267 / 272 / 277 |
| Confirm restore | 98.7 / 104.1 | 315.7 / 344.0 | 2849.5 / 3101.7 | 144 / 145 / 146 |

The save receipt remains 160–164 bytes across these tiers. Export files are about 0.4, 4.1 and 41.4 MB. The greatest sum of Host and child peak RSS across measured operations is 201.7, 244.2 and 538.3 MiB; these are conservative sums of separately observed process peaks, not simultaneous measurements. This run reports diagnostic costs, not an acceptance budget or user-capacity promise. It excludes installation, authenticated DSH transport, browser input and painting, cold filesystem caches, and external applications. The report does not establish installed-desktop acceptance or production command throughput.
