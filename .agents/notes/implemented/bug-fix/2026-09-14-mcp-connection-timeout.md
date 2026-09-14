# Agent Note: Bound MCP startup discovery

Status: implemented

English | [中文](2026-09-14-mcp-connection-timeout.zh.md)

## Problem

An MCP server that never completed `initialize` or the first `tools/list` could keep plugin activation and reconnect attempts pending indefinitely.

## Decision

Expose `connectionTimeoutMs` for stdio and Streamable HTTP (default 15 seconds, bounded by the runtime timer limit). Expiry closes the affected generation and routes the failure through existing reconnect and startup-error policy. A close observed while connect resolves is checked before discovery so dead generations cannot register tools.

## Alternatives considered

**Leave the SDK deadline implicit.** The SDK deadline is not configurable and can stall activation longer than a deployment can tolerate.

**Add a global watchdog.** A global timer cannot identify the owning MCP generation safely; the supervisor already owns its lifecycle.

## Consequences

Slow servers must complete initialization and initial discovery within the configured deadline or be retried. The timeout closes the generation before reconnect handling, preventing indefinitely pending startup and stale tool registration.

## Acceptance

- schema materializes the timeout default;
- timeout is configurable for both transports;
- a dead generation performs no discovery registration;
- focused MCP tests and package typecheck pass.
