# Agent Note: Opt-in WeChat MCP approval

Status: implemented

English | [中文](2026-09-15-wechat-mcp-approval.zh.md)

## Problem

Personal WeChat automation and Official Account drafting expose private data and external writes. MCP tool annotations cannot authorize those actions, and an extensible pre-execute listener can short-circuit another listener.

## Decision

The [optional overlays](../../../../apps/cli/config/examples/wechat/README.md) reuse the MCP client with separate namespaces, pinned top-level packages and a local approval plugin. The plugin binds each granted approval to the execution object and serialized arguments; a monotonic tool guard consumes that grant before dispatch. Unknown tool names fail closed. Every call needs approval, including desktop reads. The overlays disable automatic reconnection and do not ship in default profiles.

The [RPA recovery decision](2026-09-14-clawmaster-rpa-recovery.md) remains the owner of native RPA. These integrations do not replace it. Its runtime prerequisite objection does not prohibit explicit opt-in integrations; `uv` is present on the integration development host, but remains an operator prerequisite elsewhere.

## Alternatives considered

**Prompt-only approval:** prompts and MCP annotations cannot prevent execution when policy listeners permit a call. A final guard enforces the local grant.

**Automatic enablement:** startup could download dependencies or request operating-system access before the operator has selected an account. Explicit overlays retain operator control.

**Broad account management:** Wenyan covers article drafts, not all Official Account APIs. Adding a larger account-management server increases credential exposure without evidence that those operations are needed here.

## Consequences

The integration is source configuration, not an installed-desktop release. Keyless tests prove policy outcomes, one-time grants, disposal and Loader/MCP discovery; they do not prove live account operations or a complete recorded agent-session scenario. External server dependencies are not fully locked or sandboxed. After an uncertain write, the operator checks the external account before retrying. Both integrations require separate account acceptance without committing credentials or private conversations.
