# Model Invocation Gateway

## Status

Runtime Contract v2 follow-up for Issue #8. The native Tauri release uses one
`ModelInvocationGateway`; provider-specific request and stream conversion stays
in `native_models.rs`, outside the runtime lifecycle kernel.

## Production Path

```text
NativeRuntime purpose + session + turn
  -> ModelInvocationGateway
     -> system credential store
     -> shared bounded reqwest client
     -> OpenAI-compatible | OpenAI Responses | Anthropic | Gemini adapter
     -> normalized text/reasoning/tool events
     -> model-usage.jsonl
```

The gateway is used by the main Agent, context compression, and delegated
workflow agents. There is no API key field in the tool-loop context. Model
configuration persists only provider, HTTPS base URL, model ID, limits, enabled
state, and an opaque credential ID.

## Failure Contract

| Code | Retry | Outcome |
| --- | --- | --- |
| `model_credential_missing` | no | Open model settings and save a credential |
| `model_configuration_invalid` | no | Correct provider or HTTPS endpoint |
| `model_rate_limited` | once, pre-delta only | Retry remains bounded by the invocation deadline |
| `model_provider_unavailable` | once, pre-delta only | Provider 5xx before visible output |
| `model_transport_failed` | once, pre-delta only | Connection failed before visible output |
| `model_timeout` | no | No output arrived before the deadline |
| `model_stream_interrupted` | no | Output had started; result is uncertain and is not replayed |
| `model_response_invalid` | no | Provider stream did not match the adapter contract |
| `model_provider_rejected` | no | Provider rejected authentication, policy, or request |

Cancellation closes the owned response future and prevents retry. Secrets are
redacted from provider errors before they cross into UI-visible frames.

The shared client disables implicit process proxy discovery. A deployment may
set `CLAWMASTER_HTTPS_PROXY` to an explicit HTTP/HTTPS proxy URL without
embedded credentials; other schemes and credential-bearing URLs fail closed.

## Usage And Trace

Every attempted invocation appends a `started` and terminal record under the
same `invocationId`. Records include provider, model, purpose, session, turn,
input/output/cache tokens, first-token latency, duration, retry count, outcome,
and uncertainty. They contain neither API keys nor credential IDs. The JSONL
file is created with user-only permissions on Unix.

## Verification

- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --lib`
- `npm run validate:boundaries`
- `npm run test:scripts`
- `npm run code-map:check`

Recorded SSE fixtures cover OpenAI-compatible Chat Completions, Anthropic
Messages, and Gemini `streamGenerateContent`. They normalize to the same text
event sequence and token accounting. The formats follow the official
[OpenAI streaming events](https://platform.openai.com/docs/api-reference/responses-streaming),
[Anthropic Messages streaming](https://docs.anthropic.com/en/api/messages-streaming),
and [Gemini streamGenerateContent](https://ai.google.dev/api/generate-content)
contracts.

An opt-in installed-app provider smoke remains a release acceptance step. It
must use the system credential store and must never put a key in command-line
arguments, environment snapshots, fixtures, logs, issues, or artifacts.
