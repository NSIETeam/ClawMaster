---
description: "Unified graph retrieval across ClawMaster notes, agent memory, and file metadata for desktop users and profile maintainers."
kind: "package-bundle"
---

# @clawmaster/dsh-graph-memory

English | [中文](README.zh.md)

## Summary

Graph Memory lets the agent search notes and long-term memory through one ranking path, then shows the same topics and similar files in the sidebar. ClawMaster Desktop includes this layer. Each result names the matching terms or graph edge that caused the recall. The index is derived state outside the note vault, and refresh reads OpenViking without writing to it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

ClawMaster Desktop installs this bundle in its default profile. Its patch disables the Notes package's name-only context bridge, mounts a SQLite storage backend at `~/.clawmaster/components/graph-memory/graph.sqlite`, and mounts Graph Memory after Notes.

### What you get

`graph_memory_query` searches note bodies and OpenViking memory with one BM25 ranking and expands results over wiki links, lexical similarity, duplicate relations, and topics. `graph_memory_refresh` rebuilds the derived snapshot in process. `graph_memory_plan_writeback` classifies conclusions, decisions, and evidence for notes, and preferences and stable facts for memory; it returns reciprocal `[[links]]` as a preview and writes nothing.

The sidebar lists topic pages and evidence-backed similar-file pairs. Additional file directories are opt-in through `fileSources`. Markdown and text files contribute searchable text; presentations, spreadsheets, PDFs, images, and other binary files contribute names, paths, sizes, timestamps, and extensions only.

### Verify this checkout

```bash
npm --prefix frontends/graph-memory test
npm --prefix frontends/graph-memory run typecheck
node frontends/graph-memory/scripts/build.mjs --check
npm --prefix frontends/graph-memory run test:real-vault
```

The last command reads the configured real Notes vault and OpenViking service. It prints aggregate counts and fails unless one query recalls both a note and a memory. It does not write either source.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle inserts two rows: a SQLite storage provider and the Graph Memory host/client package. The host reads notes through `clawmasterNotes`, reads OpenViking through its HTTP API, builds a complete JSON-safe graph in process, and replaces one `ctx.storage` KV value atomically. Tools call the same engine directly; no child process or direct SQLite import exists in the component.

At step 1 of every turn, the context listener first delegates to the next listener. It then refreshes and queries the unified graph. The injected user message uses plugin source `clawmaster-graph-memory` and `form: snapshot`, so the next turn replaces the earlier snapshot. A note-list failure is logged and returns the original step unchanged.

The lexical parser and graph algorithms are adapted from the reviewed dependency-free GraphRAG source. The independent SQLite adapter, CLI, watch process, evaluation runner, and static HTML viewer do not ship in this component.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ClawMaster Notes](../notes/README.md) owns note reads, writes, revisions, and annotations.
- [Desktop packaging](../../apps/desktop-tauri/README.md) owns bundle installation and restart behavior.

-----

<a id="model-experience"></a>
## Model Experience

Direct. The model can query the unified graph and receives one attributed context snapshot at the opening step of each turn. Results include their lexical or edge evidence and retain same-title duplicate annotations.

#### KV Cache effect

Each turn contributes one bounded snapshot. A later snapshot replaces the previous plugin contribution instead of appending another persistent prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- OpenViking semantic-vector edges are not enabled; retrieval uses the shipped lexical and structural graph.
- Long-term-memory ingestion has no execution path. Writeback classification and reciprocal links are previews because memory writes require a separate owner-approved design.
- Source changes do not activate in a running desktop process. A desktop rebuild and restart are separate owner-controlled operations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
