# Historical server integration ledger

[`server-integration-baseline.json`](./server-integration-baseline.json) is a
compatibility ledger inherited from the Otto codebase. It records where the
enterprise schema, capability set, and security integrations came from. Its
`NSIETeam/otto-new` and `internal` fields are historical evidence, not the
current ClawMaster branch or release policy.

`npm run validate:integration-baseline` checks that the current package
versions, Enterprise API/schema, public capabilities, product modules, source
dispositions, and integration evidence still agree with that ledger. The
optional `--verify-git-refs` mode exists only for auditing the historical Otto
refs when those refs are available locally; current ClawMaster CI does not use
it.

The active ClawMaster source policy is defined by
`.github/workflows/tauri-preview.yml`: candidates must contain the latest
`origin/main`, accepted branch refs are `main` and `codex/windows-*`, and a
release tag must exactly equal `v<package.json version>`. See
[`GitHub Actions`](../.github/workflows/README.md) for the complete release
path.
