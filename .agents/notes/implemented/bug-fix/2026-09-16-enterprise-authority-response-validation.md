# Agent Note: Validate enterprise authority responses

Status: implemented

English | [中文](2026-09-16-enterprise-authority-response-validation.zh.md)

## Problem

The enterprise frontend delegates authentication, Session ownership, membership and approval decisions to `GovernanceAuthority`. TypeScript describes that provider, but it cannot validate a malformed response at runtime. Treating malformed output as an ordinary denial would hide provider failure and could leave different consumers with different fail-closed behavior.

## Decision

`GovernanceAccess` validates every non-empty provider response before using it. Principals require an organization, member, actor kind and a Session id for agent actors. Membership responses require a boolean active flag, known roles, bounded policy version and bounded resource identifiers. Approval responses require bounded identifiers. A missing response remains an unauthenticated, inactive or unapproved result; malformed output raises a stable provider failure that route consumers map to service unavailability. Provider exception text is never returned or stored.

The validation stays inside the shared access seam, so HTTP, DSH tools, task owners and approval commits use the same rule. Organization binding, current membership checks and independent approvals remain authoritative in their existing stores; this change does not claim to provide an OIDC implementation or a deployed multi-user service.

## Alternatives considered

**Trust the provider's TypeScript interface.** Runtime authority responses cross a plugin boundary and can be malformed despite their declared type, so compile-time checking alone cannot protect route decisions.

**Treat malformed output as a missing response.** Missing identity or membership has a defined unauthenticated or inactive result, while malformed data indicates provider failure; collapsing them would hide operational faults and make consumers disagree about failure handling.

**Validate separately in each route and tool.** That duplicates policy and permits HTTP, tools, and approval commits to interpret the same provider response differently; shared validation keeps one rule at `GovernanceAccess`.

## Consequences

Malformed authority output cannot become local access, an enterprise permission denial, or a committed mutation. The regression uses registered enterprise routes and an isolated SQLite store to check malformed HTTP identity, membership and approval output, and directly checks malformed Session identity. The existing organization mismatch and migration tests continue to cover durable organization ownership.
