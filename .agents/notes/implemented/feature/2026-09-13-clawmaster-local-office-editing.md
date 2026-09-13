# Agent Note: Local Office editing in ClawMaster

Status: implemented

English | [中文](2026-09-13-clawmaster-local-office-editing.zh.md)

## Problem

Office files need editable content and safe persistence within a task. Preview-only conversion cannot preserve an editing session, while independent document services add installation and maintenance requirements.

## Decision

The [Office bundle](../../../../frontends/office/README.md) registers DOCX, XLSX and PPTX viewers in Better Sidebar. Each iframe owns one document and uses the pinned onlyoffice-web-local release-8 editor with local WebAssembly conversion. DSH's existing WebServer and connection authentication serve verified resources; no second server is introduced. HTML resource policy restricts connections to the same origin.

Explicit preparation downloads an archive pinned by SHA-256. Builds remain offline and reject stale resources or local dependency links. Distribution preserves AGPL-3.0-only terms, ONLYOFFICE notices and corresponding-source access; ClawMaster branding does not remove these obligations.

Saves retain absolute drive/UNC paths and reuse sidebar uploads with the opened bytes' strong SHA-256 `If-Match`. Serialized commits recheck the file after receiving the body. HTTP 412 preserves changed disk content; uncertain or failed saves retain the live draft and never acknowledge success. Only confirmed writes advance the revision.

The [shell decision](2026-09-12-clawmaster-shell-over-dsh.md) retains runtime, Session and sidebar-lifetime ownership. Office persistence supplements those decisions.

## Alternatives considered

**External document server.** Existing server-dependent integrations require another managed deployment. Local conversion keeps editing available within the desktop installation.

**Preview-only rendering.** It avoids save coordination but does not provide the requested Office editing.

## Consequences

Resources add approximately 178 MiB before compression. Drafts survive only their live viewer; crash recovery is not provided. Revision checks do not promise atomic comparison against unrelated filesystem processes.

[Browser acceptance](../../../../frontends/office/tests/browser.test.mjs) verifies real edits, saved bytes, reopening and conflicts for all three formats, preserving Word tables, PowerPoint text, and Excel formulas and calculated values. Complex layout, macros, encrypted files and legacy binary formats remain unverified.
