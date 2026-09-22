# Agent Note: Obsidian-style knowledge workspaces

Status: implemented

English | [中文](2026-09-21-obsidian-style-knowledge-workspaces.zh.md)

## Problem

The Notes client placed navigation, editing and related information in one vertical flow, which reduced the document's readable area and made the available context difficult to scan. Graph Memory presented counts and ranked pairs but did not draw the stored graph, so users could not explore topology, neighborhoods or evidence from the sidebar. Every refresh also read and parsed every note even when the vault had not changed.

## Decision

Notes uses a desktop knowledge-workbench layout inspired by Obsidian's information architecture without importing Obsidian code or assets. An activity rail and vault explorer own navigation, the center document surface owns editing and preview, and a separate inspector groups annotations, backlinks, tags and review proposals. Container queries remove secondary regions as width decreases while preserving the document and existing revision, draft and approval behavior.

Graph Memory renders its validated snapshot as an interactive SVG network. A deterministic bounded force pass positions nodes, semantic colors distinguish node kinds, and the client supports search highlighting, node-kind filters, global and one-hop local scopes, pan, zoom, selection and an evidence inspector. The canvas draws at most the 140 highest-degree nodes in the active scope; this is a presentation bound and does not change the stored snapshot or retrieval path.

The Graph Memory storage unit also keeps validated source-document records. Refresh compares each Notes listing entry with the stored path, vault, byte size and modification time. It reuses an unchanged record and reads only changed or new notes before rebuilding the complete derived graph. Removing a note removes its cache record. The records are rebuildable index data rather than user content.

Both clients preserve the existing host, route, revision and approval contracts. The implementation adds no visualization framework, proprietary note format or second user-editable graph representation.

## Alternatives considered

**Keep the stacked Notes panel and adjust typography.** Typography alone would not separate navigation, document work and review context, and the document would continue to compete vertically with every auxiliary section.

**Continue presenting Graph Memory as ranked lists.** Lists expose individual relations but hide clusters, hubs and neighborhood structure, which are the main value of storing a graph.

**Add a general graph visualization dependency.** The shipped interaction set is small enough for SVG and React state. Avoiding another client dependency keeps bundle ownership and rendering behavior local, at the cost of a bounded custom layout rather than a full physics engine.

**Render every indexed node.** An unbounded SVG graph would degrade interaction and label readability on large indexes. Degree-ranked display retains the most connected structure while the complete graph remains available to retrieval and can be narrowed through filters and local mode.

**Store only the complete graph snapshot.** Rebuilding from source on every refresh is simple but charges a read and parse for every unchanged note. Rebuildable per-document records preserve source ownership while avoiding that repeated work.

**Treat metadata equality as a content guarantee.** Filesystems can preserve metadata across unusual external rewrites. Graph Memory uses metadata only to select candidates; an explicit index deletion still performs a complete source rebuild and remains the recovery path.

## Consequences

Notes gains clear desktop regions and a readable central document but hides the inspector, then the explorer, at narrow container widths. Graph topology becomes directly explorable and every selected relation retains its stored evidence. The deterministic layout spends CPU when the visible node set changes, so the display cap is part of the UI behavior.

An ordinary refresh avoids reading unchanged notes, while a changed note is the only note reparsed. The implementation still rebuilds graph-wide similarity, clusters and the atomic snapshot after source collection; it does not claim SQLite FTS5, stale-generation pagination, recovery history, sync or legacy `memory.md` migration. Those larger changes remain owned by the [knowledge vault v2 proposal](../../proposed/architecture/2026-09-22-obsidian-compatible-knowledge-vault-v2.md).
