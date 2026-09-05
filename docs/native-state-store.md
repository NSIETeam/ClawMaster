# Native State Store

## Status

`NativeStateStore` is the encrypted Rust persistence owner for the Tauri
runtime. It lives at `runtime-store-v1` under the application data directory,
which is deliberately separate from beta JSON/JSONL and `.otto*` paths. On the
first launch only, the runtime may read a legacy `native-runtime.json` and copy
its state into the encrypted store. It never rewrites or deletes that beta file.

Production model usage, runtime metadata, sessions, and individual messages use
the shared database. A manifest in the index tree names the active records;
removal updates the manifest while old encrypted records remain recoverable.
Message keys combine session and message IDs so client IDs cannot collide across
sessions. Memory, checkpoint, and artifact callers still migrate tree by tree;
Issue #7 remains open until those legacy owners are removed and installed
recovery acceptance is complete.

## Security And Ownership

- One process-level registry returns the same database handle for the same
  canonical path.
- A random 256-bit master key is generated once and stored in macOS Keychain or
  Windows Credential Manager. No environment or ordinary configuration key is
  accepted.
- AES-256-GCM encrypts each complete record with random nonces and tree/key
  associated data. Logical IDs are SHA-256 keys rather than plaintext sled
  keys.
- Named trees cover session, event, memory, index, artifact metadata, encrypted
  artifact bytes, checkpoint, usage, and tombstone records.
- `put_cas` rejects stale revisions. `put_once` enforces event and usage
  idempotency. Checkpoint/event pairs commit in one sled transaction.
- Corrupt records move to the encrypted tombstone tree; scans continue returning
  healthy records and a typed corruption list.
- Large output uses encrypted content-addressed artifacts and returns only a
  hash/length reference. The store has no plaintext cache or polling task, and
  disables sled periodic flushes.
- Runtime mutations and model usage explicitly flush after durable writes;
  periodic background flushing remains disabled.

Every structured record carries schema version, revision, created/updated
timestamps, source ID, and payload. The model gateway updates `started` and
terminal phases under one invocation ID, leaving one logical usage record.

## Verification

```bash
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --lib native_state_store::tests
npm run validate:boundaries
npm run test:scripts
```

The focused suites cover same-path singleton ownership, plaintext-at-rest
search, 100 replay attempts, concurrent CAS conflicts, cross-tree transaction
abort, per-message corrupt-record isolation, cross-session message IDs, restart
recovery, 2 MiB artifact integrity, and byte-for-byte protection of beta paths.
