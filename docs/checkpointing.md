# Checkpointing and File Recovery

ClawMaster has three independent recovery mechanisms. They solve different
failure modes and must not be presented as interchangeable.

## Rust-Native File Recovery

The Tauri runtime creates a private, per-file checkpoint before a direct
file-writing tool runs. Users can inspect these points in the right-side
**Versions** workspace or with `/restore`, then restore one only after the
standard high-risk confirmation.

The implementation is owned by
`packages/desktop/src-tauri/src/native_encrypted_checkpoints.rs` and the shared
`native_state_store.rs`, with these invariants:

- Only ordinary files inside the current canonical workspace are eligible.
  Absolute paths, parent traversal and symbolic-link targets are rejected.
- A checkpoint records the pre-write bytes and the post-write digest. Restore
  proceeds only when the current digest still equals the post-write digest, so
  later user edits are never overwritten.
- Restore affects one file. It does not run `git clean`, reset the repository,
  restore conversation history or repeat the original tool call.
- A successful restore creates another checkpoint first, providing an undo
  path. If that undo point cannot be finalized, the file remains restored and
  the UI reports the reduced recovery guarantee explicitly.
- Metadata and before-image bytes are AES-256-GCM encrypted. Before-images are
  content-addressed and deduplicated; logical IDs are not stored as plaintext
  sled keys. The master key remains in the system credential store.
- Checkpoint metadata and its capture event commit in one sled transaction.
  Legacy beta files may be copied in once, but are never modified or deleted.
- Files larger than 32 MiB are rejected. Storage is pruned to at most 200
  checkpoints and 256 MiB, while the checkpoint currently being created is
  preserved. The UI shows the newest 100 points.
- Failed writes discard their unfinished checkpoint. Temporary replacement
  files are cleaned up, and replacement uses a backup swap so Windows does not
  depend on Unix overwrite semantics.

Direct tools currently covered are `write_file`, `generate_docx`,
`generate_pptx`, `generate_chart`, `merge_pdfs` and `optimize_pdf`.
`run_command` is deliberately excluded because an arbitrary process can mutate
multiple files and external systems; claiming complete rollback would be
false.

## Runtime Continuity

The inherited TypeScript runtime keeps two records under
`~/.otto-user/checkpoints/` while that compatibility runtime remains:

- `turn-{turnId}.json` protects turn execution and replay classification.
  `NEVER_REPLAYED` actions remain skipped after recovery.
- `{sessionId}.cp.json` stores resumable session summaries and pending-task
  signals.

These records do not authorize filesystem restoration and are not the source
for the desktop Versions workspace.

## Rejected Shadow-Git Design

The old `GitService` shadow repository under
`~/.otto-user/history/<project-hash>` is not the production recovery path. Its
restore flow can apply repository-wide operations such as `git clean -fd`,
which cannot distinguish Agent changes from unrelated user work. ClawMaster
therefore uses bounded Rust-native file snapshots instead of reviving that
design in the packaged desktop runtime.

## Verification

Required checks include Rust capture/finalize/restore tests, conflict and path
escape tests, retention tests, protocol validation, renderer state tests and
the right-panel recovery interaction test. A packaged candidate must also prove
that the confirmation card shows the resolved relative path and that a real
restore refreshes the visible timeline.
