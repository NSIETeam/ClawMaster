---
description: "ClawMaster and WatchDog identity with the existing DSH system-prompt assembly."
kind: "package-reference"
---
# clawmaster-sys-prompt

English | [中文](README.zh.md)

## Summary

ClawMaster presents an enterprise collaboration identity in WatchDog while retaining DSH tool guidance and runtime context. Business components primarily supply tools and data for AI work. Available tools and the active approval service determine which actions can run.

## Configuration

The [desktop policy](../defaults/cordis.patch.yml) disables the upstream `system-prompt` row and inserts this module as `clawmaster-sys-prompt`. Its configuration disables the upstream identity opener and supplies the product persona. Every accepted field comes from [DSH SystemPrompt](../../../packages/core/system-prompt/README.md).

User profile patches run last and must target `id: clawmaster-sys-prompt` to customize the active service. Patches targeting `id: system-prompt` modify the disabled upstream entry; their configuration is not migrated. A configuration patch replaces the whole object, so retain `includeHarnessIdentity: false` and every other desired field.

To select the upstream service explicitly, disable `clawmaster-sys-prompt` and enable `system-prompt` in the same user patch. Enabling both entries creates competing registrations for the same service.

## Implementation

[index.mjs](index.mjs) re-exports the original default service and all named runtime APIs. Packaging places this component at `apps/clawmaster-sys-prompt` and resolves its dependency from the same installation. No separate assembly, schema, permission policy, or logging implementation is introduced.

## Model Experience

The prompt starts with ClawMaster's WatchDog collaboration identity. DSH contributes tool sections and runtime-context snapshots through its existing registries.

## Known Limitations and Deferred Work

- A persona does not grant business access or approval. The configured services enforce those decisions.
- This module is a desktop composition component; it has no standalone application entry.
