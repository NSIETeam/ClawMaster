# Agent Note: Stop unbounded retries for permanent model failures

Status: implemented

English | [中文](2026-09-14-llm-retry-permanent-failure-guard.zh.md)

## Problem

The provider-owned `always` retry mode treated every failure as recoverable. Authentication, quota, missing-model, unsupported-capability, and context-overflow failures therefore scheduled another request until cancellation or plugin disposal. This can create an avoidable request and cost storm while the underlying condition cannot change through an identical call.

## Decision

Keep `always` unbounded only for transient failures. After downstream recovery has been given the first opportunity, `dsh-llm-retry` delegates permanent failures without scheduling a retry. The classification uses the stable provider-neutral codes already emitted by the LLM adapters: `AUTH`, `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_CREDENTIAL`, `MISSING_CREDENTIAL`, `UNKNOWN_MODEL`, `NO_ADAPTER`, and `UNSUPPORTED_OPTION`.

The decision is local to the retry executor. Providers remain responsible for mapping wire failures to stable codes, and deployments still choose normal-mode budgets and provider backoff. No new model-visible event is introduced; a permanent failure is represented by the existing failed request and turn settlement.

## Acceptance

- Always mode does not append `llm/retry` or arm a timer for each classified permanent code.
- Downstream `agent/request-error` recovery still runs before the classification.
- Transient failures retain the existing durable-before-wait behavior and unbounded always-mode retry semantics.
- Focused retry tests cover credential, quota, context, and unknown-model failures.

## Alternatives considered

**Retry every failure with a larger cap.** This still repeats requests that cannot succeed without changing credentials, model, or payload.

**Classify errors in each provider.** Provider-specific parsing would duplicate policy and miss failures emitted by shared adapters.

## Consequences

Permanent failures now settle immediately in `always` mode, while transient failures keep their existing retry behavior. Deployments must change the request or configuration before retrying a permanent failure.
