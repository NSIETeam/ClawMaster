# Agent Note: ClawMaster system-prompt identity

Status: implemented

English | [中文](2026-09-13-clawmaster-system-prompt-identity.zh.md)

## Problem

The desktop needs its own enterprise collaboration identity without taking ownership of DSH's prompt assembly and extension APIs.

## Decision

[`clawmaster-sys-prompt`](../../../../apps/desktop-tauri/sys-prompt/README.md) re-exports the original DSH service and named APIs. Desktop policy selects the component on the existing `system-prompt` row and uses the upstream `includeHarnessIdentity` and persona fields. The product persona names ClawMaster and WatchDog, treats business systems as AI tools and data, and defers protected actions to actual approval services.

The trimmed installation carries the component and resolves DSH from its local workspaces. Official DSH profiles keep their own defaults. Prompt text does not replace tool authorization or add access.

## Alternatives considered

**Fork prompt assembly.** A fork would duplicate the registry, context, and rendering behavior that the desktop already reuses.

**Rename the upstream package.** Changing DSH package identity would disturb existing dependency and plugin consumers. A product composition alias preserves those APIs.

## Consequences

Product identity remains independently configurable while DSH owns assembly and logging semantics. A keyless assembly check compares actual tool sections and approval context through the re-exported service; release startup tests exercise the composed desktop profile.
