# Agent Note: Unify note and memory retrieval through Graph Memory

Status: implemented

English | [中文](2026-09-14-graph-memory-unified-retrieval.zh.md)

## Problem

ClawMaster exposes a human-owned Notes vault and an agent-owned long-term-memory service. The Notes context bridge matches only note names and paths, does not read note bodies, and suppresses a note after its first match for one agent. The two stores therefore remain separate retrieval systems even though both can contain the same subject.

## Decision

The desktop profile includes `@clawmaster/dsh-graph-memory` after Notes and disables the Notes package's name-only bridge. Graph Memory indexes note bodies and read-only OpenViking memory in one lexical and structural graph. Both document kinds use the same BM25 ranking with no source boost. Results retain matched terms, traversed edges, and exact or same-title duplicate annotations.

At step 1 of every turn, Graph Memory delegates through the `agent/pre-step` waterfall before it reads sources. It appends one message attributed to the `clawmaster-graph-memory` plugin with `form: snapshot`. A later turn replaces the earlier contribution. If the Notes service cannot list its vault, the listener logs the failure and returns the delegated decision unchanged.

## Storage and source ownership

The component persists one validated graph snapshot through a `ctx.storage` KV unit. The desktop bundle provides the SQLite backend at `~/.clawmaster/components/graph-memory/graph.sqlite`, outside every indexed directory. The complete replacement prevents readers from observing a partly rebuilt graph.

Notes remain owned by `clawmasterNotes`; Graph Memory never reads the note directory around that service. OpenViking remains an external read-only source. Optional filesystem sources are explicit configuration. Text files contribute lexical content, while every other file type contributes metadata only.

## Writeback ownership

The existing Guard result review and Notes tools own note writes. Graph Memory supplies a dry-run classifier: conclusions, decisions, and evidence target notes; preferences and stable facts target memory; each proposed record carries a reciprocal `[[link]]`. The classifier has no write path. Long-term-memory ingestion remains absent because this change has no authority to write or delete memory.

## Verification

Package tests cover `ctx.storage` replacement, direct tool calls, zod-derived schemas, equal-source retrieval, per-turn snapshot injection, failure preservation, duplicate evidence, binary metadata-only indexing, and topic/similarity rendering. A separate read-only command indexes the real Notes vault and configured OpenViking service and fails unless one query recalls both kinds.

The adapted algorithm baseline is the independently developed GraphRAG source tree whose stable aggregate SHA-256 was `73c9775d42850789f4e73ea298cfab250eb98dc18917ddeca1772ed60bf7a222`; its observed gates were 50 main tests and 9 tool tests.

## Alternatives considered

**Keep the Notes name bridge.** This cannot retrieve body-only concepts and suppresses a relevant note after one match, so it does not make notes a peer memory source.

**Run the independent CLI from each tool.** A subprocess would duplicate lifecycle and error handling, bypass the shared storage service, and retain an independent SQLite owner inside the product.

**Copy the complete independent package.** The CLI, watch process, evaluation runner, SQLite adapter, and static HTML viewer duplicate product-owned services. The component keeps the dependency-free graph algorithms and replaces those adapters with Notes, storage, authenticated routes, and the sidebar.

**Write notes into OpenViking automatically.** This would create a long-term-memory write path without separate authorization, conflict handling, or deletion policy. The product retains the dry-run ingestion boundary.

## Consequences

One query and one opening context path can recall note and memory content with inspectable evidence. People see the same graph's topics and similar documents in the sidebar. Refresh cost scales with the current source sizes because the implementation rebuilds one complete snapshot. Semantic-vector edges and executed reciprocal writeback remain unavailable until their owners approve those operations.
