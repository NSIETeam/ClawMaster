# Agent Note: Typed enterprise resource grants

Status: implemented

English | [中文](2026-09-17-typed-resource-grants.zh.md)

## Problem

Enterprise membership grants used bare resource identifiers across records, tasks, schedules and workspace allocation. The same identifier could therefore name different resource types under one grant. Submitting an order also changes its referenced inventory rows, so permission for the order alone is not sufficient.

## Decision

The Host creates resource keys with `governanceResource(kind, id)`. Record families use `record/contact`, `record/inventory`, `record/order` and `record/audit`; other families use `task`, `schedule` and `workspace`. Identifiers are URI-encoded before they enter the key. `governanceResourceCollection(kind)` returns the family wildcard, while `*` remains the organization-wide grant.

The shared `GovernanceAccess` evaluator accepts an exact key, a matching `<family>/*` grant or `*`. It rejects untyped resource strings even when an authority returns a matching bare-ID grant. Every HTTP route, DSH tool, task Host, schedule Host/runtime and managed-workspace allocator sends the same typed key for a resource. Querying a whole family requires its family wildcard or the organization-wide grant. A scoped query by ID checks that exact resource key.

Order submission checks write permission for the order and every referenced inventory item before approval or commit. The approval remains bound to the order ID, command, generation, revision and digest.

Bare resource grants are not translated. They are ambiguous across families and fail closed; an enterprise authority must update its grant mapping before deploying this version. Local mode keeps its device-owned authorization and does not consume enterprise resource grants.

## Alternatives considered

**Keep bare identifiers.** They cannot distinguish a contact, inventory item, task and schedule that reuse one ID.

**Require only organization-wide `*`.** This removes ambiguity but removes useful least-privilege grants for individual records and resource families.

## Consequences

Typed grants preserve exact-resource and family-wide access without letting equal identifiers cross resource families. Existing authority integrations must migrate grants explicitly; the application does not infer or broaden them. The product does not bundle an identity provider, attachment service or multi-organization desktop deployment, so those paths still need deployment-specific integration and acceptance.

The governance access tests cover exact keys and family wildcard refusal across resource types. Registered HTTP and tool query tests use the same record identifier in contacts and inventory and refuse the unauthorized collection. Receipt tests cover typed authorization and approvals over HTTP and DSH ToolRuntime. Two-organization fixtures reject foreign principals from HTTP records, writes, backup export and DSH tools.
