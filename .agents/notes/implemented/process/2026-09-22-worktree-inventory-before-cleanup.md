# Agent Note: Inventory uncommitted work before any worktree cleanup

Status: implemented

English | [中文](2026-09-22-worktree-inventory-before-cleanup.zh.md)

## Problem

Work accumulated in the desktop checkout faster than it could be reviewed: the remediation baseline recorded 59 tracked modifications and 126 untracked entries while the installed app already ran a later build, and the same checkout carried the only copy of work that had never been committed. Tidying that work without a written inventory risks deleting files nobody has classified, and neither the repository nor the release tooling could answer "what is uncommitted right now, and where is its backup" with evidence.

## Decision

`apps/desktop-tauri/scripts/worktree-inventory.mjs` writes an inventory of the checkout and archives the uncommitted work beside it, and never writes to, stages, or deletes anything in the checkout it reads.

- `captureWorktreeInventory` reads `git status --porcelain=v1 -z --untracked-files=all` and describes every entry: status, kind, size, mtime, and a SHA-256 digest for files at or below 64 MiB. Symlinks record their target instead of being followed; a directory entry is listed without descending into it.
- Porcelain output is read without trimming. Git marks an unstaged-only change as ` M`, so trimming the buffer shifts every path by one character; `gitRawText` exists for that reason.
- `writeInventory` emits `worktree-inventory.json` for tooling and `worktree-inventory.md` for a human, and both name every path. An empty section stays visible rather than being dropped.
- `archiveUncommittedWork` writes a binary patch of the tracked changes and a tar of the tracked and untracked files, so the backup is independent of the checkout staying intact.
- `runWorktreeInventory` is the single entry point used by the CLI and by tests, so the verified path is the shipped path.

## Alternatives considered

**Clean or delete uncommitted files before recording an inventory and independent archive.** Issue #11 explicitly requires preserving existing work and forbids using an empty workspace as version governance; an inventory paired with an archive records the contents and leaves recovery possible before any later cleanup.

## Consequences

The inventory is evidence, not authority: it records what the checkout held at capture time, and nothing re-reads it to decide what may be deleted. A digest for a file above the size ceiling is `null`, which a reader must treat as "not digested here" rather than "unchanged".

Deleting or committing the inventoried work stays a human decision; the tool adds no cleanup step of its own. Archives land under the given output directory, defaulting to `.dsh-build/worktree-inventory`, which build provenance already ignores.
