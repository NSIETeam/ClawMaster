# Agent Note: WatchDog linked Session evidence status

Status: implemented

English | [中文](2026-09-18-watchdog-linked-session-evidence-status.zh.md)

## Problem

WatchDog stores task evidence as a location supplied by the submitter. A location can become inaccessible, but resolving arbitrary paths or URLs would expose files or cause server-side requests outside the task's authorization.

## Decision

Task forms can cite an already linked Session as `dsh-session://<sessionId>`. Task reads resolve only this reference form. The Host requires the Session ID to appear in the task's linked Sessions and, in enterprise mode, checks the current Session identity against task-read authority in the same organization and principal. It confirms Session existence from the live Session registry or by opening and closing the persisted Session read-only; it does not read Session events.

The response carries an optional read-time aggregate `evidenceAvailability` value and does not persist it. A missing or unlinked Session is `unavailable`; a permission denial is also `unavailable`. Any external, local-file or free-form location stays `unchecked`. Unexpected storage or authority failures also stay `unchecked`, so evidence resolution does not make the task service unavailable. The Host never makes a network request for evidence locations. If adding the status would exceed the configured response-byte budget, the Host omits the computed field and the client uses `unchecked`.

An `available` result means that an authorized task-linked Session exists. It does not verify the Session's content or business claim; a human must still inspect it before acceptance. Historical task revisions resolve against current Session and authority state.

## Alternatives considered

**Fetch submitted URLs to check status or content.** This can reach internal network services, disclose credentials or expose server-local resources, so the Host does not dereference them.

**Treat every location as unchecked.** This avoids network access but cannot identify a missing internal Session that the Host can validate using its existing authorization and persistence services.

**Persist availability with the evidence.** Session existence and authorization can change, so a stored result would become stale and would misrepresent current access.

## Consequences

Task evidence retains its existing durable format; only response records add an optional computed field. DSH Session references are straightforward to resolve and the form can select only Sessions already linked to the task. Other file attachments still need a separately governed storage and retrieval capability.

## Verification

`frontends/dsh/tests/watchdog-tasks.test.mjs` exercises persisted Session availability, missing Session status, and external URL non-resolution through the registered authenticated task route. `frontends/dsh/tests/task-board.client.spec.mjs` exercises Session-reference selection and the availability message. The local authorization mode is covered; enterprise authorization behavior still needs deployment-level identity-provider acceptance.
