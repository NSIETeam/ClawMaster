# Agent Note: Enterprise cross-organization path coverage

Status: implemented

English | [中文](2026-09-18-enterprise-cross-organization-path-coverage.zh.md)

## Problem

The enterprise frontend exposes a trusted `GovernanceAuthority` seam, but interface-level checks alone do not prove that registered business entry points reject a principal from another organization. ClawMaster enterprise issue #3 also names attachment access, although this frontend currently has no enterprise attachment-serving route or store.

## Decision

The governance integration test exercises the registered enterprise overview, command, backup export and `enterprise_query` tool with a principal authenticated by the fixture authority as organization `two` against organization `one` data. It verifies rejection, no business mutation, refusal of an unrecognized local desktop token and rejection of identity fields added to command JSON. Existing workspace-route scenarios separately prove that a foreign principal cannot allocate a managed workspace. These tests exercise the trusted authority seam; they do not implement or validate an external identity provider.

The frontend has no registered attachment route or enterprise attachment store. `attachments.read` remains an authorization vocabulary entry for a future consumer and does not make DSH's general attachment capability organization-aware. A deployment must supply an IdP-backed `GovernanceAuthority`, and any attachment-serving or IM/plugin consumer must be implemented and tested through the shared access service before enterprise use.

## Alternatives considered

**Treat a DSH desktop token or caller-provided member fields as enterprise identity.** Rejected because a local application credential does not prove organization membership, and request JSON is controlled by the caller.

**Claim attachment isolation from the permission enum.** Rejected because there is no ClawMaster attachment-serving path on which to enforce or test that permission.

## Consequences

Registered enterprise HTTP, export and tool paths have a two-organization regression case, while the missing attachment consumer and external identity integration remain visible deployment blockers. This code evidence does not establish OIDC configuration, production IdP behavior, IM/plugin mediation, real enterprise deployment, local-to-enterprise migration or desktop acceptance.
