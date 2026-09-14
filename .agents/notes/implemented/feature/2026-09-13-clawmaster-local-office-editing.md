# Agent Note: Local Office editing in ClawMaster

Status: implemented

English | [中文](2026-09-13-clawmaster-local-office-editing.zh.md)

## Problem

Office files need editing and safe persistence within a task. Independent document services add deployment requirements.

## Decision

The [Office bundle](../../../../frontends/office/README.md) registers DOCX, XLSX and PPTX viewers in Better Sidebar. Each iframe owns one document and uses the pinned onlyoffice-web-local release-8 editor with local WebAssembly conversion. DSH's existing WebServer and connection authentication serve verified resources; no second server is introduced. HTML resource policy restricts connections to the same origin.

Explicit preparation downloads an archive pinned by SHA-256. The desktop release downloader retries transient HTTP failures at most three times; authorization failures and failed hash checks remain fatal. Builds remain offline and reject stale resources or local dependency links. Distribution preserves AGPL-3.0-only terms, ONLYOFFICE notices and corresponding-source access; ClawMaster branding does not remove these obligations.

Editor frames use timers when missing native idle callbacks would stop WebKit initialization. Preparation guards Chromium memory sampling and canonicalizes presentation theme URLs, retaining authentication, path checks and legal markup.

Saves retain absolute drive/UNC paths and reuse sidebar uploads with the opened bytes' strong SHA-256 `If-Match`. Serialized commits recheck the file after receiving the body. HTTP 412 preserves changed disk content; uncertain or failed saves retain the live draft and never acknowledge success. Only confirmed writes advance the revision.

The [shell decision](2026-09-12-clawmaster-shell-over-dsh.md) retains runtime, Session and sidebar-lifetime ownership. Office persistence supplements those decisions.

Toolbar dirty/save state feeds the existing sidebar host. Occurrence-owned close guards reuse its renderer modal before close, replacement, refresh or in-place file switches; cancellation and repeated requests preserve the iframe. The editor's own Save control retains the same revision checks. Application shutdown and cross-pane remounts still require prior saving.

## Alternatives considered

**External document server.** Local conversion avoids another managed deployment.

**Preview-only rendering.** It does not provide Office editing.

## Consequences

Resources add approximately 178 MiB before compression. Drafts survive only their live viewer; crash recovery is not provided. Revision checks do not promise atomic comparison against unrelated filesystem processes.

[Browser acceptance](../../../../frontends/office/tests/browser.test.mjs) verifies real edits, saved bytes, reopening and conflicts for all three formats, preserving Word tables, PowerPoint text, and Excel formulas and calculated values. Complex layout, macros, encrypted files and legacy binary formats remain unverified.
