# Agent Note: RPA tools publish object-rooted JSON schemas

Status: implemented

English | [中文](2026-09-17-rpa-object-rooted-tool-schemas.zh.md)

## Problem

The RPA component registered property maps as `ToolDefinition.parameters`. DSH and model providers treat that field as a JSON Schema document, whose root must declare `type: object` and `properties`. The map therefore reached the model without an object type, producing an invalid tool schema.

## Decision

Publish `rpa_run`, `rpa_native`, and `rpa_call` parameters as explicit object-rooted JSON Schemas. Put mandatory fields in the root `required` array, reject unknown top-level fields, and keep the recovered native tool arguments open because their properties vary by native tool.

## Alternatives considered

**Treat `parameters` as an implicit property map.** The DSH tool registry forwards this field as JSON Schema and does not infer an object root for a hand-written definition, so this leaves the model-facing schema invalid.

**Leave the root open to unknown fields.** The three RPA entrypoints have fixed top-level arguments; allowing extra fields adds no supported behavior and makes the published input contract less precise.

## Consequences

All three RPA tools now expose the schema form expected by model APIs. A regression test checks the root type, declared properties, required fields, and the intentionally open nested `arguments` object without requiring the native helper binary.
