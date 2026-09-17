# Agent Note: Session prompt claim idempotency

Status: implemented

English | [中文](2026-09-17-session-prompt-claim-idempotency.zh.md)

## Problem

A retried Session prompt can arrive after AgentLoop claims its inbox message but before the loop records `user/message`. During that interval, live queue inspection and the durable user history contain no matching request id, so the retry can admit duplicate work.

## Decision

`SessionCommandController` treats a matching `agent/inbox/spliced` insertion as durable admission evidence. AgentLoop appends this event before it can claim the message; the event carries the inserted user messages and their `rpcId`. The controller therefore returns the original accepted result across the claim-to-history interval, while retaining the existing live-queue and `user/message` checks. A real AgentLoop pre-step barrier test retries the same request id during this interval and verifies one durable user message and one model request.

## Alternatives considered

**Inspect only the current inbox and `user/message` history.** Claim removes the message from the projection before `user/message` is logged, leaving a real gap in both sources.

**Keep a separate process-local completed-request registry.** It would duplicate the durable inbox record and lose its authority on process restart.

## Consequences

Retries remain idempotent after AgentLoop has claimed work, using the existing Session log as the record. The guarantee depends on the inbox insertion event retaining the request id and preceding claim, as the current AgentLoop persistence path does. The integration test exercises the production AgentLoop path and observes both the durable message and provider request count.
