# R07 Context and Memory Acceptance

Issue: #11

## Implemented contracts

- `MemoryRecord` is the formal encrypted record for new memory. It carries a
  user, project, or session scope plus evidence, confidence, sensitivity,
  expiry, replacement, revision, manual priority, and tombstone state.
- Source-event replay is idempotent across restart. Forget and supersede are
  authoritative and cannot be reversed by replaying an older event.
- Recall uses an in-process Chinese unigram/bigram and English/code token
  index. Scope filtering happens before candidate ranking and no embedding
  model or external retrieval service is used.
- Context is bounded and ordered as safety/current task, StateCapsule, recent
  messages, relevant memory, then selected tool/skill summaries. Unknown
  models use a conservative 16K budget.
- Tool schemas are selected again on each model step and are hard limited to
  1200 estimated tokens. `native_capabilities` remains available for discovery.
- Complete tool output is stored as an encrypted content-addressed artifact.
  The UI and model receive only a bounded summary, SHA-256, and byte length.
- StateCapsule persists the current goal, referenced memory IDs, incomplete
  tool calls, approval state, verification results, and revision across restart.
- Agent, compression, and sub-agent requests all use
  `ModelInvocationGateway`; the encrypted UsageLedger stores one upserted
  record per invocation with session, turn, purpose, provider, and model.

## Automated evidence

Run from `packages/desktop/src-tauri`:

```text
cargo test --lib
163 passed; 0 failed; 3 ignored
```

The ignored tests are explicit opt-in checks for public GitHub access, a real
provider credential, and a subprocess helper. The two localhost WebSocket/SSE
tests fail inside the filesystem sandbox because listener creation is denied;
the same full command passes outside that sandbox.

Focused gates cover:

- 50,000 records: Recall@5 >= 90%, Precision@5 >= 80%, cold query below
  150 ms, and warm p95 below 50 ms.
- 10,000 adversarial cross-scope queries with zero leakage.
- Forget, supersede, source-event replay, process restart, and no UsageLedger
  growth from replay.
- A 20 KB private tool result absent from model context and plaintext storage,
  with exact recovery through its artifact reference.
- Unknown-model 16K fallback, 2200-token system prompt bound, 1200-token tool
  schema bound, and message-before-memory ordering.
- StateCapsule goal, pending action, approval, memory IDs, and unknown outcome
  restoration after restart.

## Fixed baseline and final installed gate

The fixed comparison commit is
`61ce7eb8e3462e9d0bdb0fde9e736c920f6df47b`. A direct probe of that commit with
the long-memory fixture produced an estimated 6001 tokens in the system prompt
alone and confirmed that the full memory fixture was present.

R07 remains open until the final installed-provider acceptance runs the same
successful task corpus against the fixed baseline and candidate. The release
gate requires median candidate input tokens to fall by at least 40% and success
rate to fall by no more than two percentage points. That run is shared with R03
so it incurs one real-provider acceptance pass rather than duplicate calls.
