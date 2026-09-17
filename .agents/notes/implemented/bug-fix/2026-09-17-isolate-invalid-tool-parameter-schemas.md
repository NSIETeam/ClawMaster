# Agent Note: Isolate invalid tool parameter schemas

Status: implemented

English | [中文](2026-09-17-isolate-invalid-tool-parameter-schemas.zh.md)

## Problem

A parameter getter or snapshot error in one registered tool could abort assembly of the complete model request. A schema with a non-object root could also reach a tool provider that expects a model function schema. Checking external schemas with DSH's argument-validator subset would reject valid JSON Schema keywords used by MCP tools.

## Decision

The registry snapshots each tool's description and parameter schema independently whenever it builds native or PTC projections. A projected parameter schema must be lossless JSON and have a root `type: "object"`; every other JSON Schema keyword is preserved without subset validation. An invalid definition is omitted from all model-facing projections, while valid siblings remain. A direct dispatch rechecks the same requirements before policy approval or tool execution and fails closed. A later valid projection clears that definition's quarantine state.

The required `run_code` presentation transport remains fail-loud if its own schema cannot be read. This isolation applies to tool definitions after registration; it does not catch Cordis plugin startup failures.

## Alternatives considered

- Applying `assertSupportedJsonSchema` to parameter schemas would reject valid external keywords such as `$ref`, `$defs`, `format`, and `anyOf`.
- Rejecting the whole registry or model request when one optional tool is malformed preserves strictness at the cost of every healthy tool.
- Accepting non-object roots risks sending schemas the model-function protocol cannot represent.

## Consequences

An invalid tool can remain registered for lifecycle and diagnostics, but it is not advertised or executable. Diagnostics identify the tool and failure category without including getter-thrown details. Cordis activation failures require a separate plugin-composition containment design.

## Verification

`packages/core/tools/tests/tools.spec.ts` verifies sibling retention, unreadable/lossy/non-object schemas, advanced-keyword preservation, and rejection before approval or execution. `packages/core/tools/tests/ptc.spec.ts` verifies native PTC transport and SDK projections omit the same unreadable tool while healthy bindings remain callable.
