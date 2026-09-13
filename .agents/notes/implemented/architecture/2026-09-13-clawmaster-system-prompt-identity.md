# Agent Note: ClawMaster system-prompt identity

Status: implemented

English | [中文](2026-09-13-clawmaster-system-prompt-identity.zh.md)

## Problem

The desktop needs its own enterprise collaboration identity without taking ownership of DSH's prompt assembly and extension APIs.

## Decision

[`clawmaster-sys-prompt`](../../../../apps/desktop-tauri/sys-prompt/README.md) re-exports the original DSH service and named APIs. Desktop policy disables the upstream `system-prompt` entry and inserts a `clawmaster-sys-prompt` entry using the upstream `includeHarnessIdentity` and persona fields. The product persona names ClawMaster and WatchDog, treats business systems as AI tools and data, and defers protected actions to actual approval services.

The trimmed installation carries the component and resolves DSH from its local workspaces. Official DSH profiles keep their own defaults. Prompt text does not replace tool authorization or add access.

## Alternatives considered

**Fork prompt assembly.** A fork would duplicate the registry, context, and rendering behavior that the desktop already reuses.

**Rename the upstream package.** Changing DSH package identity would disturb existing dependency and plugin consumers. A product composition alias preserves those APIs.

**Change a row's name through a patch.** The Include plugin treats a patch's `name` as a matching guard. A different name skips the patch; service replacement therefore uses the existing disable-and-insert operations.

## Consequences

Product identity remains independently configurable while DSH owns assembly and logging semantics. User configuration must target the product entry; old-id configuration remains on the disabled upstream entry. The component README owns override and explicit upstream-selection instructions.

The keyless check applies the actual base, Web, and desktop patch layers through Include, rejects warnings or multiple active prompt services, and assembles the selected entry with real tool sections and approval context. Its negative control rejects a name-mismatch patch. Release startup tests exercise the composed desktop profile.
