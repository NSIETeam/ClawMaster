---
description: "ClawMaster and WatchDog identity with the existing DSH system-prompt assembly."
kind: "package-reference"
---
# clawmaster-sys-prompt

English | [中文](README.zh.md)

## Summary

ClawMaster presents an enterprise collaboration identity in WatchDog while retaining DSH tool guidance and runtime context. Business components primarily supply tools and data for AI work. Available tools and the active approval service determine which actions can run.

## Configuration

The [desktop policy](../defaults/cordis.patch.yml) selects this module for the existing `system-prompt` row, disables the upstream identity opener, and supplies the product persona. User profile patches still run last. Every accepted field comes from [DSH SystemPrompt](../../../packages/core/system-prompt/README.md).

## Implementation

[index.mjs](index.mjs) re-exports the original default service and all named runtime APIs. Packaging places this component at `apps/clawmaster-sys-prompt` and resolves its dependency from the same installation. No separate assembly, schema, permission policy, or logging implementation is introduced.

## Model Experience

The prompt starts with ClawMaster's WatchDog collaboration identity. DSH contributes tool sections and runtime-context snapshots through its existing registries.

## Known Limitations and Deferred Work

- A persona does not grant business access or approval. The configured services enforce those decisions.
- This module is a desktop composition component; it has no standalone application entry.
