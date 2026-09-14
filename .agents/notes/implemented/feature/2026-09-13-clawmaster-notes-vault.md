# Agent Note: Durable ClawMaster notes with explicit writes

Status: implemented

English | [中文](2026-09-13-clawmaster-notes-vault.zh.md)

## Problem

New users need a notebook without installing an external editor. Agent writes and concurrent editors must not silently overwrite work or turn a conflict into deletion.

## Decision

The [Notes component](../../../../frontends/notes/README.md) owns plain Markdown files in a configurable user directory. It reuses DSH authentication, tool types, approval and sidebar registration instead of introducing another server. Every agent mutation requires a one-shot approval; unloading cancels pending approval work.

Cooperative writers serialize revision checks and writes through the existing cross-process file lock. Atomic replacement protects complete saved contents; no-replace publication protects occupied destinations. Linked descendants are rejected. Shared text parsing keeps Node filesystem code out of the browser.

The client retains drafts by Session in plugin memory because sidebar closing has no veto callback. Conflicts retain drafts and disk contents; explicit reload and deletion require in-panel confirmation.

Review sits between drafting and writing. `notes_propose` stores a draft and the revision it was based on under the vault's ignored `.clawmaster/` directory and returns a line diff, without touching a note, so it needs no approval; `notes_write` actions `apply-proposal` and `discard-proposal` settle it. Applying is revision-guarded, so a note that moved in the meantime is refused rather than overwritten and the proposal survives for a retry. The diff is computed host-side by a bounded, dependency-free line diff, so the model and the user read the same thing.

Finished work becomes notes through one composed entry: `notes_digest` takes what was done plus optional decisions, evidence and next steps, links a matching project note, and appends a dated section to the daily note in a single write. Scheduling that at the end of a task belongs to the WatchDog task layer, not to this module.

Revision requests scan file metadata on demand and coalesce concurrent scans; the component uses neither native watching nor a background timer. Versions also include the pending-proposal digest, so proposal changes refresh without a note edit. Scan failures reach the request and can be retried; unsaved drafts remain intact.

The panel reads like the host's own file manager rather than a generic list, because a sidebar tab that invents its own metrics looks bolted on. Rows are 34px tall with a 6px icon gap and `depth * 22 + 6` inline indent, folder rows carry the strong label weight, hover uses the interactive token and the open note uses the business tint — values measured from `dsh-better-sidebar`'s explorer styles. `src/tree.ts` derives folders from note ids so the panel actually nests, and `src/icons.tsx` supplies inline SVG glyphs on one 16px grid, so the module still ships no raster asset. Obsidian's `app.css` contributes the smaller cues: a 13px UI type scale, muted letterspaced section headers, a quiet unsaved marker, and prose typography for the rendered view.

## Alternatives considered

Requiring Obsidian excludes fresh installations. A separate HTTP server duplicates authentication. Blind overwrite or automatic conflict recovery loses user intent. A durable draft database adds another content owner and is deferred.

## Consequences

Saved notes remain portable files, while unsaved drafts do not survive process exit. The file lock is cooperative, not OS isolation from hostile writers; crash durability and stale-lock recovery remain explicit [limitations](../../../../frontends/notes/README.md#known-limitations-and-deferred-work). Creation and renaming require hard links.

## Verification

`npm --prefix frontends/notes test` builds and exercises storage and Host behavior, including concurrent writes, path restrictions, read/write budgets, proposal drift, annotations, denied approval, unloading and on-demand refresh. Artifact tests load `dist/index.js` directly.

`npm run test:notes-client` builds and runs compiled-client tests under jsdom for draft retention, explicit discard, failed proposal-load retry, annotations, out-of-order reads and revision conflicts. The runner pins `NODE_ENV=test` to retain React test APIs.

Real-browser and final installed-UI acceptance remain independent of jsdom and type checks and must use the regenerated installer.

`npm --prefix frontends/notes run typecheck` checks strict types; `node frontends/notes/scripts/build.mjs --check` verifies artifact freshness.
