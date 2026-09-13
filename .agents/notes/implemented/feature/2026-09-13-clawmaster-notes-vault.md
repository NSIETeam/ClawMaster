# Agent Note: Durable ClawMaster notes with explicit writes

Status: implemented

English | [中文](2026-09-13-clawmaster-notes-vault.zh.md)

## Problem

A built-in notebook must preserve drafts, share portable files with external editors, and separate an agent's proposed changes from approved note mutations.

## Decision

The [Notes component](../../../../frontends/notes/README.md) uses DSH authentication, tool types, approval and sidebar registration. Host and Client ship together with eight JSON routes. `notes_write` and `notes_digest` require an owning agent and one-shot approval. Every tool joins plugin lifetime tracking; unloading cancels pending approvals and waits for active operations and watcher scans.

Cooperative writers serialize revision checks through the existing cross-process lock. Atomic replacement protects saves; no-replace publication protects occupied destinations. Checked paths reject linked descendants. Proposal JSON under `.clawmaster/proposals` uses the same storage protections and bounded reads. It remains accessible externally while excluded from the note index. Drafting persists metadata without another approval; source Markdown changes only on application.

The visible panel polls a version covering notes and bounded proposal contents. Drafts survive concurrent refresh, navigation, rename and proposal application in Session-scoped plugin memory. Conflicts preserve drafts and disk contents; explicit reload and deletion require confirmation. Nested folders and inline SVG icons reuse the host's visual conventions.

## Alternatives considered

Requiring Obsidian excludes fresh installations. A second server duplicates authentication. Blind overwrite and automatic draft replacement lose user intent. A durable draft database introduces another content owner.

## Consequences

Unsaved drafts do not survive process exit. Filesystem isolation, crash durability, hard-link requirements and fingerprint limitations remain explicit [limitations](../../../../frontends/notes/README.md#known-limitations-and-deferred-work).

## Verification

Storage, lifecycle and built-Host tests exercise synthetic files, late approval after unload, proposal budgets and metadata-only revision changes. Compiled-client tests cover draft races, automatic proposal refresh and confirmation flows. Type checking and artifact freshness checks pass. These checks do not establish final installed-UI acceptance.
