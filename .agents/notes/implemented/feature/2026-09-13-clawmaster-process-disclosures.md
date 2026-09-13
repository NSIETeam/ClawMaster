# Agent Note: ClawMaster process details on demand

Status: implemented

English | [中文](2026-09-13-clawmaster-process-disclosures.zh.md)

## Problem

Enterprise users need task results and actionable failures without reading technical process text. Collapsing a body while retaining its reasoning, memory, or command preview still exposes that text in the conversation.

## Decision

The existing ClawMaster build profile omits reasoning and context previews and shell/code summaries from collapsed headers. Source labels and short failure summaries remain visible. The existing disclosures retain complete available inputs and outputs; background shell receipts also remain expandable. React state records manual expansion for the mounted row, without an effect that resets it during streaming or completion. Existing completed-Turn grouping continues to own whole-process folding.

Presentation does not modify Session events, model inputs, final answers, or approval controls. Other DSH builds retain their existing previews. The [shell decision](2026-09-12-clawmaster-shell-over-dsh.md) owns the product/runtime separation; the [Chat](../../../../packages/client/ui-chat/README.md) and [Tool](../../../../packages/client/ui-tool/README.md) references own component behavior.

## Alternatives considered

**Hide previews with CSS.** Hidden technical text remains in the rendered content and can still affect accessibility or search.

**Reset expansion whenever content changes.** Streaming would close details the user deliberately opened.

## Consequences

Users open technical detail explicitly. Expansion is local UI state, not a durable preference across reloads. Collapsed error rows remain recognizable without exposing raw stderr or stack traces.

## Verification

Component tests cover default collapse, manual expansion through updates, background receipts, failed terminal exits, ordinary result summaries, and unchanged DSH previews. English and Chinese rendered-text snapshots pin the collapsed headers. Existing Chat tests retain coverage for final answers and approval presentation.
