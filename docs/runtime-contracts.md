# Runtime Contract v2

Runtime Contract v2 is the versioned boundary between ClawMaster clients and the
native runtime. Its single source of truth is
`packages/runtime-contracts/schema/v2/runtime-contract.schema.json`, using JSON
Schema 2020-12.

## Generated Artifacts

Run `npm run runtime-contracts:generate` after changing the schema. The command
generates both language surfaces from the same source:

- `packages/runtime-contracts/src/generated.ts` for core, server, and desktop
- `packages/runtime-contracts/generated/runtime_contract_v2.rs` for Tauri

Generated files include the source SHA-256. `npm run runtime-contracts:check`
fails when either artifact is stale. CI regenerates both files and rejects a
diff, so generated files must never be edited by hand.

## Envelope Rules

Every request and event carries `requestId`, `sessionId`, `turnId`, `stepId`,
`traceId`, `eventId`, `sequence`, `timestamp`, `schemaVersion`, and `actor`.
Sequences are positive and monotonic per session. Replaying an identical
`eventId` is idempotent; replaying it with different content is a stable
`RUNTIME_DUPLICATE_EVENT_CONFLICT` error.

Protocol major versions must match. Minor and patch differences are negotiated
through the shared capability set. Unknown events may be skipped only when
`ignorable` is true; an unknown mandatory event fails closed with
`RUNTIME_UNKNOWN_REQUIRED_EVENT`.

The schema covers initialization and capability negotiation, session lifecycle,
prompt/cancel/approval, memory, workspace and usage requests, plus content,
tool, approval, cancellation, error, memory, compression, checkpoint, usage and
completion events.

## Validation And Golden Tests

`packages/runtime-contracts/src/runtime.ts` validates the TypeScript boundary.
`packages/desktop/src-tauri/src/runtime_contracts.rs` provides the equivalent
Rust boundary. Both test suites consume the JSON frames in
`packages/runtime-contracts/golden`, which protects semantic serialization,
required identifiers, enums, version compatibility, unknown-event policy,
sequence monotonicity and replay behavior.

The Tauri command `runtime_contract_version` reports protocol `2.0.0`, schema
`2.0.0`, and the live v1-adapter usage count. The legacy `runtime_activity`
message remains a renderer compatibility projection; it is versioned as 2 but
is not a substitute for a Runtime Contract v2 envelope.

## V1 Compatibility And Removal

The v1 event adapter supports only the explicitly mapped `userMessage` and
`runtimeError` frames. Every use increments the observable
`runtime_contract_v1_adapter_used` counter. Other v1 event types fail closed.

R11 owns adapter deletion. Removal requires one stable release with a zero
adapter count, no supported client advertising protocol major 1, and golden
fixtures proving that all retained runtime paths emit v2 directly.
