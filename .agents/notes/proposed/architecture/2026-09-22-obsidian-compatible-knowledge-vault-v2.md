# Agent Note: Obsidian-compatible knowledge vault v2

Status: proposed

English | [中文](2026-09-22-obsidian-compatible-knowledge-vault-v2.zh.md)

## Problem

Issue #32 asks ClawMaster to turn memory, notes, and the knowledge graph into a user-owned knowledge product comparable to Obsidian. Its 2026-09-22 task brief describes an older or incomplete runtime observation: the current source already ships a local Markdown Notes vault, frontmatter, tags, daily notes, wiki-link navigation, backlinks, deterministic text search, reviewable agent proposals, annotations, and a derived Graph Memory index over note bodies and optional OpenViking memory.

The remaining gap is still material. Notes search scans the vault, Graph Memory rebuilds a complete JSON snapshot, the sidebar presents topics and similar pairs rather than a navigable relationship canvas, `.canvas` files are read-only, and there is no product-owned sync, recovery timeline, template system, or migration from legacy `memory.md`. Treating those gaps as if no foundation existed would create a second vault and a second graph instead of finishing the product users already have.

## Proposal

Keep the existing Notes vault as the only user-editable source of truth. Evolve Graph Memory into a disposable, versioned index of that vault and optional read-only memory sources. Session databases remain historical runtime facts and must never be moved into the vault or renamed.

This proposal extends, and does not yet supersede, the implemented [Notes vault](../../implemented/feature/2026-09-13-clawmaster-notes-vault.md) and [unified graph retrieval](../../implemented/architecture/2026-09-14-graph-memory-unified-retrieval.md) decisions. Implementation starts only after review accepts the ownership, migration, and OpenViking choices below.

## Verified baseline and corrected gap matrix

The baseline is source and package-test evidence from `main` at `5566bec`. The Notes suite passed 187 tests with four platform skips; Graph Memory passed all 14 tests. The D2 session suite passed 77 tests. The D7 browser handoff regression still reproduced as HTTP 400 until its HTML fixture gained the `<head>` required by CSP nonce injection.

| Area | Current source | Remaining gap | Priority |
|---|---|---|---|
| Portable storage | Configurable local Markdown vault outside runtime state | Legacy `memory.md` import and explicit vault selection/migration | P0 |
| Links and backlinks | Wiki links, standard Markdown links, real backlinks, missing-link creation | Persistent incremental link index and unresolved-link browser | P0 |
| Graph | Typed nodes/edges, evidence, topics, similarity, unresolved links | Interactive global/local graph canvas and note navigation | P0 |
| Reliability | Revision-guarded atomic writes, proposals, approvals, D2 append healing | Recovery snapshots, trash, and field soak evidence | P0 |
| Search | Deterministic bounded title/body search and BM25 graph retrieval | Incremental FTS5 index, snippets, filters, and stale-generation handling | P1 |
| Organization | Frontmatter, tags, nested folders, daily notes | Properties UI, templates, MOCs, bookmarks, and outline | P1 |
| Sync/versioning | Plain files can be managed by external Git or sync tools | Product-owned recovery UI and documented sync conflict policy | P1 |
| User control | Edit/delete/rename, diff review, approvals, source-attributed annotations | Recoverable deletion and per-change history | P1 |
| Editing | Edit/preview modes and safe Markdown rendering | Live preview, outline, multi-cursor, and editable Canvas | P2 |
| Extensions | DSH tools and plugin composition | No compatibility promise for Obsidian community plugins | P2 |

The current `graph.sqlite` containing a single KV row is not evidence that the graph is empty: Graph Memory deliberately persists one atomically replaced, validated graph snapshot through `ctx.storage`. It is, however, a scalability constraint because every refresh replaces the whole snapshot.

## Defect disposition from the task brief

- **D2 is already implemented on `main`.** `Session.append` snapshots legacy injection payloads, supplies missing message identity fields, and validates the resulting surface event. The focused Session suite passed all 77 tests. Seven days of field `session-doctor` observation remains operational evidence, not a code change that this proposal can claim.
- **D7 was still reproducible.** The browser-open fixture omitted `<head>`, so the production CSP nonce renderer correctly refused it with HTTP 400. This branch makes the fixture a structurally valid shipped document and the focused browser handoff test now returns 200.
- **D9 does not describe this source tree.** The named `scripts/tests/*.test.js` files and the enterprise/E2EE implementation they exercise exist on the separate `dsh-workline` snapshot, not on current `main`. Current `main` owns `scripts/tests/*.spec.ts`, already matched by `scripts/**/*.spec.ts`. Copying orphan tests without their product source would create a false red gate; the snapshot must be reconciled as a separate history/import decision.
- **D12 is already implemented on `main`.** The local-only runtime-health route and home layer expose disabled plugin names without leaking host details to a shared deployment. Native rescue also records the disabled names. Per-plugin functional probes remain explicitly outside that feature's contract.

## Ownership and storage

`@clawmaster/dsh-notes` continues to own all Markdown and `.canvas` files, revision checks, proposals, annotations, and user-approved mutations. The vault stays an ordinary directory that Obsidian can open without conversion. ClawMaster may add its own private derived state only below `.clawmaster/`, which Obsidian can ignore and users can delete safely.

`@clawmaster/dsh-graph-memory` owns no user content. It owns a rebuildable SQLite index outside the vault. One committed generation contains:

- `pages(path, title, hash, mtime_ms, properties_json)`;
- `links(src_path, target, resolved_path, kind, evidence)`;
- `entities(id, name, type, source_path)` and `mentions(entity_id, source_path, start_offset, end_offset)`;
- `relations(src_entity, dst_entity, kind, evidence_path, evidence_start, evidence_end, producer, review_state)`;
- `pages_fts`, an FTS5 external-content index over title, path, properties, and Markdown body.

Every relation keeps human-inspectable evidence. Rule-derived links and frontmatter entities may publish automatically because they are reproducible. Model-derived entities and relations remain proposals until a person accepts them; accepted facts are written to visible Markdown/frontmatter before the derived index observes them.

## Indexing and query contract

An initial scan records content hashes. Later scans use metadata only to find candidates, hash changed candidates, parse only changed files, and commit a new generation atomically. A query binds to one generation. Pagination against an older generation fails explicitly as stale rather than mixing results.

Search treats user text as data, never executable FTS syntax. Results include a bounded snippet, matched fields, note revision, and generation. Graph queries and the UI consume the same indexed nodes and edges, so the model and person do not see contradictory graphs.

The first graph UI is read-only: global/local mode, kind filters, search, zoom, pan, node selection, evidence-backed edges, and opening a note from a node. It does not edit relations or claim Obsidian Canvas compatibility.

## Migration and rollout

1. Detect the configured Notes vault and legacy `memory.md`; never scan or rename `~/.dsh/sessions/` as migration input.
2. Produce a dry-run manifest showing every proposed note, link, collision, and byte count. No source file changes during discovery.
3. Import approved legacy entries as one Markdown file per durable fact with `source`, `created`, `updated`, and `legacy_source` frontmatter. Keep the original file until an explicit later cleanup.
4. Build the derived index from the resulting visible files and compare counts, hashes, backlinks, unresolved links, and search hits with the manifest.
5. Enable the new search/graph UI behind a reversible configuration flag for one release. The existing scan/search and snapshot graph remain the fallback.

OpenViking remains an optional read-only semantic source during the rollout. It is not a fact store and cannot write the vault. After two weeks of measured recall evaluation, keep it only if it adds accepted hits that deterministic vault search misses; otherwise remove it from the default desktop package list and retain an explicit third-party integration path.

## Alternatives considered

**Create a new vault beside ClawMaster Notes.** This duplicates content ownership, backlinks, approvals, and migration. The shipped Notes vault already satisfies the local-first boundary.

**Make the session database the knowledge source of truth.** Sessions are append-only runtime history with strict path/header identity. Editing or renaming them would repeat the corruption behind D1/D2 and would not produce portable knowledge files.

**Store accepted model entities only in SQLite.** Users could not audit or edit those facts in Obsidian, and deleting the index would destroy knowledge. Accepted facts therefore land in visible files; SQLite remains derived.

**Use OpenViking as the primary store.** A disabled external service cannot provide deterministic offline writes or user ownership. It may enrich recall, but it cannot replace the vault.

**Promise full Obsidian compatibility.** Community plugins, Dataview semantics, and editable Canvas are separate products. The compatibility contract is the ordinary directory, Markdown/frontmatter, wiki links, and non-destructive private metadata only.

## Acceptance criteria

- Obsidian opens the same vault and can edit every user-owned note without an export or proprietary conversion.
- A changed note is the only content reparsed during an incremental refresh; deleting the index and rebuilding yields the same nodes, links, and FTS hits.
- Wiki links, Markdown links, backlinks, unresolved targets, tags, and properties have deterministic fixtures covering Unicode paths and ambiguous titles.
- Search returns bounded snippets and rejects stale pagination generations.
- The graph view renders real nodes and edges, supports global/local navigation, and opens the selected note; it remains usable at the documented node cap.
- Agent writes remain proposal-first, revision-guarded, approval-gated, and source-attributed. Model-derived graph facts are never silently committed.
- Migration has dry-run, collision, interruption, retry, and rollback tests and never writes or renames a session directory.
- English and Chinese documentation, configuration catalog, package tests, installed-desktop smoke tests, and an end-to-end demo pass before rollout.

## Risks

Incremental indexing adds schema migration and stale-generation complexity. FTS5 tokenization must be documented for Chinese text and cannot be marketed as semantic search. Opening the same vault in two applications leaves filesystem races outside cooperative locks, so conflict preservation remains mandatory. Graph layout can become unreadable at large sizes and must cap rendering without silently dropping query results. A recovery timeline consumes storage and needs an explicit retention policy. OpenViking evaluation must not send private vault content to an unapproved remote service.
