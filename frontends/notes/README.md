---
description: "ClawMaster notes: local Markdown editing, wiki links, search and approval-gated agent writes."
kind: "package-bundle"
---

# ClawMaster Notes

English | [中文](README.zh.md)

## Summary

ClawMaster includes a local notebook for Markdown editing, previews, wiki links, backlinks, tags and text search. You can ask the agent to organise work into notes and approve each proposed write. The product creates its own vault without requiring Obsidian. Saved notes remain ordinary files; unsaved drafts remain in memory for the current application session.

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

Create or open a note, edit its text and choose **Save**. A revision conflict preserves both your draft and the newer file. **Reload** explicitly asks before discarding that draft. Switching notes or closing and reopening the Notes tab retains drafts for the same Session while the plugin remains loaded. **Delete** requires confirmation and does not use the trash.

<a id="configuration"></a>
## Configuration

The [host configuration](src/host.ts) accepts an absolute `vaultRoot`. Its default is `~/Documents/ClawMaster 笔记` on macOS and `~/ClawMasterNotes` elsewhere, outside the desktop runtime directories. Reads, listings, search, tags and backlinks share these limits; appending also respects the read limit.

| Field | Default | Meaning |
|---|---|---|
| `limits.maxReadBytes` | 262144 | Maximum bytes read from one note. |
| `limits.maxTreeEntries` | 5000 | Maximum notes visited in a listing. |
| `limits.maxSearchResults` | 50 | Default and maximum search hits; configurable up to 200. |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The [host](src/host.ts) registers six routes on the existing authenticated DSH Fetch carrier: GET `tree`, `note`, `search`, `tags` and `backlinks`, plus POST `command`, under `/api/clawmaster/notes/`. The carrier owns authentication and origin checks; the browser uses same-origin credentials. No additional server is started. Tool definitions, execution contexts and approvals use the public DSH types. Disposal removes registrations, cancels pending approvals and waits for active operations.

The [vault](src/vault.ts) rejects linked files and linked directories below its canonical root. Cooperative writers share a cross-process file lock; revision checks and mutation receipts are calculated while holding it. Saves publish complete temporary files through atomic replacement. Creation and renaming use hard links that refuse an occupied destination. The browser renders parsed Markdown data rather than raw HTML, and [shared text parsing](src/note-format.ts) does not rewrite frontmatter.

</details>

<a id="model-experience"></a>
## Model Experience

`notes_query` reads the configured vault without a write approval. `notes_write` creates, saves, appends, renames, deletes or adds a dated diary entry. Every AI write requires an owning DSH agent Session and an `allowed-once` approval; denial, cancellation or plugin unloading prevents a pending approval from committing. A save supplies the revision obtained from a read and returns a conflict when it differs. Receipts report the previous and resulting revisions, not a recoverable copy of deleted or replaced content. Direct authenticated UI commands are user edits and do not request an additional agent approval.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Markdown editing supports a subset of formatting; this component does not implement Obsidian plugins or a canvas editor. Search scans files rather than a persistent index.
- Drafts are not persisted across process exit. The browser receives an unload warning when drafts exist; native application quit protection is not verified.
- File locks coordinate cooperating writers; they do not isolate hostile or uncooperative processes replacing ancestors or racing the final filesystem operation. Writes do not promise crash durability through `fsync`.
- Creation and renaming require hard-link support. A failed rename cleanup can leave both paths, with an explicit error. A lock left by abnormal exit requires manual verification and recovery; the component does not remove it automatically.

<a id="verification"></a>
## Verification

From the repository root with development dependencies installed, run the storage/host tests, compiled-client interactions, type check and artifact freshness check:

```sh
npm --prefix frontends/notes test
pnpm exec vitest run --config frontends/notes/tests/vitest.client.config.ts
npm --prefix frontends/notes run typecheck
node frontends/notes/scripts/build.mjs --check
```

These checks exercise synthetic files and controlled browser responses. They do not establish acceptance of the final installed Notes UI.

<a id="further-exploration"></a>
## Further Exploration

See the [design decision](../../.agents/notes/implemented/feature/2026-09-13-clawmaster-notes-vault.md), [wire validation](src/protocol.ts) and [desktop integration](../../apps/desktop-tauri/README.md).

### Dev Note

None.
