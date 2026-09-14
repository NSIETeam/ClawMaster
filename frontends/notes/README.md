---
description: "ClawMaster notes: local Markdown editing, wiki links, search, diff-reviewed agent proposals and approval-gated writes."
kind: "package-bundle"
---

# ClawMaster Notes

English | [中文](README.zh.md)

## Summary

ClawMaster includes a local notebook for Markdown editing, previews, wiki links, backlinks, tags and text search. You can ask the agent to record finished work as notes, or to propose an edit and show you the diff before anything is written, and you approve each write that touches a note. The product creates its own vault without requiring Obsidian. Saved notes remain ordinary files; unsaved drafts remain in memory for the current application session.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Verification](#verification)
- [Further Exploration](#further-exploration)

<a id="use-this-package"></a>
## Use this package

This private component is included in the ClawMaster desktop profile through its [bundle patch](cordis.patch.yml). Open **Notes** from the sidebar tab selector. The host creates the configured vault when the plugin loads and seeds a welcome note when it contains no supported notes.

Create or open a note, edit its text and choose **Save**. A revision conflict preserves both your draft and the newer file. **Reload** explicitly asks before discarding that draft. Switching notes or closing and reopening the Notes tab retains drafts for the same Session while the plugin remains loaded. **Delete** requires confirmation and does not use the trash. **Rename** moves the note through the vault, refusing an occupied destination. **Today's note** opens the dated diary note, creating it once.

A wiki link resolves to its note; when several notes match you choose, and when none matches you are offered the note's creation. A `.canvas` file opens read-only with saving and renaming disabled, because this component has no canvas editor.

**Proposals** appear in the side panel with the diff they would apply, each with **Apply** and **Discard**. Applying is revision-guarded: if the note moved since the proposal was drafted, the apply is refused and the proposal stays for a retry.

**Annotations** sit above the proposals in that panel: each mark shows its kind (comment, highlight, to-do or risk), who left it — a person or an agent — and the line or quoted fragment it anchors to, without touching the note's own text. Marks are re-read on every poll, so one the agent writes appears while you are reading the note.

**Related notes** reach the agent the same way a memory would: at the start of each turn the host reduces the request to its own words and matches them against the notes' names and paths, then hands the model a short, attributed block naming what matched — at most a few notes, each named once per session, and never a note's contents in place of the note. A request that matches no name injects nothing, and `notesContext: off` serves the vault without volunteering anything.

While the tab is visible the panel polls the vault version, so edits made by another editor or by the agent appear without a manual refresh. An unsaved draft is never discarded by that refresh: the panel reports the external change and offers a reload.

<a id="configuration"></a>
## Configuration

The [host configuration](src/host.ts) accepts an absolute `vaultRoot`. Its default is `~/Documents/ClawMaster 笔记` on macOS and `~/ClawMasterNotes` elsewhere, outside the desktop runtime directories. Reads, listings, search, tags and backlinks share these limits; appending also respects the read limit.

| Field | Default | Meaning |
|---|---|---|
| `limits.maxReadBytes` | 262144 | Maximum bytes read from one note. |
| `limits.maxTreeEntries` | 5000 | Maximum notes visited in a listing. |
| `limits.maxSearchResults` | 50 | Default and maximum search hits; configurable up to 200. |
| `notesContext` | `related` | Whether each request is matched against the notes' names and the matches handed to the model; `off` never volunteers a note. |
| `maxContextNotes` | 3 | Most notes one injection may name, up to 10. |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The [host](src/host.ts) registers the Notes routes on the existing authenticated DSH Fetch carrier: GET `tree`, `note`, `search`, `tags`, `backlinks`, `proposals` and `revision`, plus `annotations` (GET reads a note's marks, POST adds or removes one) and POST `command`, under `/api/clawmaster/notes/`. The carrier owns authentication and origin checks; the browser uses same-origin credentials. No additional server is started. Tool definitions, execution contexts and approvals use the public DSH types. Disposal removes registrations, drains revision scans, cancels pending approvals and waits for active operations.

The [vault](src/vault.ts) rejects linked files and linked directories below its canonical root. Cooperative writers share a cross-process file lock; revision checks and mutation receipts are calculated while holding it. Saves publish complete temporary files through atomic replacement. Creation and renaming use hard links that refuse an occupied destination. The browser renders parsed Markdown data rather than raw HTML, and [shared text parsing](src/note-format.ts) does not rewrite frontmatter.

Proposals and diffs are separate concerns. The [proposal store](src/proposals.ts) keeps drafts as JSON under the vault's ignored `.clawmaster/` directory — never listed as notes and never visible to an external editor browsing the vault — and records the revision each draft was based on. The [line diff](src/diff.ts) is bounded and dependency-free: it is exact for ordinary notes, degrades to a whole-file replacement above 2000 lines a side rather than building a huge table, and truncates an oversized result with an explicit marker.

[Marks](src/annotations.ts) are stored the same way, one JSON file per annotation under `.clawmaster/annotations`: a note's own text is never rewritten to record a comment, two writers cannot clobber each other, and the vault fingerprint does not move — so marking a note never looks like an external edit. A mark anchors to a line, to a quoted fragment, or to the note as a whole, and records whether a person or an agent wrote it.

The [retrieval policy](src/context.ts) behind related notes is pure and testable: it reduces a request to whole latin words and two-character Han windows, ranks the notes whose *titles* match those tokens (newer first on a tie), and renders a bounded, source-attributed block. Matching names only is a deliberate cost decision — reading note bodies would charge one file read per note on every turn — and the block tells the model to open a note before trusting its contents.

[Live refresh](src/watcher.ts) scans file metadata on each revision request and coalesces concurrent scans. It uses neither native watching nor a background timer. The revision also includes the proposal digest, so creating or discarding a proposal refreshes its list without changing any note. A failed scan is reported to the caller and can be retried.

The [panel](src/client.tsx) is styled as host chrome rather than a generic list. [Tree](src/tree.ts) derives folders from note ids so rows nest, with 34px rows, a 6px icon gap and `depth * 22 + 6` inline indentation — the metrics the host's own file-manager explorer uses. [Icons](src/icons.tsx) are inline SVG glyphs on one 16px grid, so the module ships no raster asset.

</details>

<a id="model-experience"></a>
## Model Experience

`notes_query` reads the configured vault without a write approval, including the pending proposals and a note's marks (`mode: annotations`). `notes_propose` drafts a change and returns its line diff **without writing any note**, so it needs no approval — it is how the agent shows a change first. `notes_write` creates, saves, appends, renames, deletes, adds a dated diary entry, or applies and discards a stored proposal. `notes_digest` composes one dated work entry from what was done plus optional decisions, evidence and next steps, links a matching project note, and appends it to the daily note; that is the primitive for turning finished work into notes. `notes_annotate` marks a note — a comment, a highlight, a to-do or a risk, anchored to a line, a quoted fragment or the note itself — recording the source so a person's mark and an agent's mark never read as the same thing, and it is approval-gated like every other write.

Every AI write requires an owning DSH agent Session and an `allowed-once` approval; denial, cancellation or plugin unloading prevents a pending approval from committing. A save supplies the revision obtained from a read and returns a conflict when it differs. Applying a proposal supplies the revision the draft was based on and is refused on drift. Receipts report the previous and resulting revisions, not a recoverable copy of deleted or replaced content. Direct authenticated UI commands are user edits and do not request an additional agent approval.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Markdown editing supports a subset of formatting; this component does not implement Obsidian plugins or a canvas editor, and a canvas opens read-only. Search scans files rather than a persistent index, and listing reads one head per note for its title.
- Live refresh polls while the panel is visible. Detection latency includes the poll interval and filesystem scan; large vaults cost more per scan.
- Drafts are not persisted across process exit. The browser receives an unload warning when drafts exist; native application quit protection is not verified.
- File locks coordinate cooperating writers; they do not isolate hostile or uncooperative processes replacing ancestors or racing the final filesystem operation. Writes do not promise crash durability through `fsync`.
- Creation and renaming require hard-link support. A failed rename cleanup can leave both paths, with an explicit error. A lock left by abnormal exit requires manual verification and recovery; the component does not remove it automatically.

<a id="verification"></a>
## Verification

From the repository root with development dependencies installed, run the storage/host tests, the compiled-client tests, the type check and the artifact freshness check. The client runner builds the bundle first, because it drives the shipped artifact rather than the source:

```sh
npm --prefix frontends/notes test
npm run test:notes-client
npm --prefix frontends/notes run typecheck
node frontends/notes/scripts/build.mjs --check
```

These checks exercise synthetic files and controlled browser responses. They do not establish acceptance of the final installed Notes UI.

<a id="further-exploration"></a>
## Further Exploration

The [Agent Note](../../.agents/notes/implemented/feature/2026-09-13-clawmaster-notes-vault.md) records why the module exists, the decisions behind the storage and review model, and what was verified.
