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

External edits are noticed rather than raced. A visible panel polls a vault version published by a fingerprint plus a recursive watch; the fingerprint is the authority, so a missed or unsupported watch event degrades to a slower refresh instead of a stale view, and a watch that cannot be attached is recorded rather than swallowed. An unsaved draft is never discarded by that refresh: the panel reports the external change and offers the same reload affordance as a stale save.

## Alternatives considered

Requiring Obsidian excludes fresh installations. A separate HTTP server duplicates authentication. Blind overwrite or automatic conflict recovery loses user intent. A durable draft database adds another content owner and is deferred.

## Consequences

Saved notes remain portable files, while unsaved drafts do not survive process exit. The file lock is cooperative, not OS isolation from hostile writers; crash durability and stale-lock recovery remain explicit [limitations](../../../../frontends/notes/README.md#known-limitations-and-deferred-work). Creation and renaming require hard links.

## Verification

`npm --prefix frontends/notes test` builds and then runs 120 tests across 27 suites, so the suite always exercises the shipped artifact. Storage and host suites cover independent writers, path escapes, failed publication, read budgets, rejected approvals, unload races, digest composition and project linking, proposal drift refusal, diff block ordering and truncation, external-edit detection, route status mapping and approval denial leaving the vault unchanged. The `artifact` suite loads `dist/index.js` directly.

`npm run test:notes-client` builds and then runs 19 compiled-client tests under jsdom against `dist/client.js`: conflicts retain drafts without deleting or reloading, drafts survive navigation and tab close, deletion is confirmed in-panel, out-of-order reads are ignored, backlinks are real, duplicate creation and stale applies are refused, rename, wiki ambiguity, create-missing, the read-only canvas view, search hits and the daily entry point all behave. The runner pins `NODE_ENV=test`, because a production `NODE_ENV` in the caller's shell resolves React's production build and removes `act`.

Type checking passes under the repository's `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noUnusedLocals`, `node frontends/notes/scripts/build.mjs --check` matches `dist/`, and the desktop packaging suite passes. Final installed-UI acceptance remains separate: it requires a regenerated bundle and an application restart.
