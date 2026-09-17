# Agent Note: Enterprise backup timeout retries

Status: implemented

English | [中文](2026-09-17-enterprise-backup-timeout-retry.zh.md)

## Problem

An upload timeout could return its refusal while the request handler still held the active backup admission slot waiting for the sender's unresolved stream read. An immediate retry then saw `storage_unavailable` instead of reaching request validation.

## Decision

When the request is aborted, race its active body read against the abort signal so the route can finish and release its operation admission promptly. Do not cancel the HTTP-owned request body before sending the refusal. Keep its reader lock until an outstanding transport read settles, then release it. This preserves the response carrier while allowing the next request to proceed.

## Alternatives considered

**Keep the operation admission slot until the request body read settles.** A stalled sender can hold the slot indefinitely, preventing a valid later request from reaching validation.

**Cancel the HTTP-owned body before returning the refusal.** The request body belongs to the HTTP carrier; canceling it before writing the response can disrupt that response. Racing the read against abort lets the handler release admission while leaving the pending transport read to settle under its existing owner.

## Consequences

The timeout contract separates handler lifetime from transport-read settlement: storage and admission can be released after abort, while the reader remains locked until the carrier resolves the outstanding read. The regression test proves that a malformed immediate retry receives `invalid_request` after an idle upload times out, and that disposal retains the reader lock until its pending read settles.
