# Agent Note: Durable ClawMaster notes with explicit writes

Status: implemented

English | [中文](2026-09-13-clawmaster-notes-vault.zh.md)

## Problem

New users need a notebook without installing an external editor. Agent writes and concurrent editors must not silently overwrite work or turn a conflict into deletion.

## Decision

The [Notes component](../../../../frontends/notes/README.md) owns plain Markdown files in a configurable user directory. It reuses DSH authentication, tool types, approval and sidebar registration instead of introducing another server. Every agent mutation requires a one-shot approval; unloading cancels pending approval work.

Cooperative writers serialize revision checks and writes through the existing cross-process file lock. Atomic replacement protects complete saved contents; no-replace publication protects occupied destinations. Linked descendants are rejected. Shared text parsing keeps Node filesystem code out of the browser.

The client retains drafts by Session in plugin memory because sidebar closing has no veto callback. Conflicts retain drafts and disk contents; explicit reload and deletion require in-panel confirmation.

## Alternatives considered

Requiring Obsidian excludes fresh installations. A separate HTTP server duplicates authentication. Blind overwrite or automatic conflict recovery loses user intent. A durable draft database adds another content owner and is deferred.

## Consequences

Saved notes remain portable files, while unsaved drafts do not survive process exit. The file lock is cooperative, not OS isolation from hostile writers; crash durability and stale-lock recovery remain explicit [limitations](../../../../frontends/notes/README.md#known-limitations-and-deferred-work). Creation and renaming require hard links.

## Verification

Storage tests cover independent writers, path escapes, failed publication and read budgets. Host tests cover rejected approvals and unload races. Compiled React tests cover conflicts, retained drafts and deletion confirmation in both locales. Final installed-UI acceptance remains separate.
