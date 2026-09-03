# Contributing to ClawMaster

Keep changes focused, reviewable, and backed by observable verification. The
repository-level operating rules are in [`AGENTS.md`](../AGENTS.md).

## Pull requests

Use the repository pull request template and include scope, acceptance
criteria, changed-file rationale, test evidence, and rollback notes. For
branch-based work, compare against `origin/main`:

```bash
git fetch origin main
scripts/verify-pr.sh --base origin/main
```

For business rules, state transitions, and data conversion in `packages/core`,
`packages/server`, or `packages/desktop`, add or update a focused regression
test before the implementation.

## Local verification

Start with cheap checks, then expand according to the affected surface:

```bash
npm run doctor
git diff --check
npm run validate:integration-baseline
npm run validate:boundaries
npm run code-map:check
npm run typecheck
npm run lint:ci
npm run test:ci
```

Use `npm ci` for clean installs. The lockfile must resolve through the official
npm registry. Never disable TLS verification, store credentials in repository
files, or print raw tokens in logs.

## GitHub policy

CI runs for pull requests to `main` and pushes to `main` or
`codex/windows-*`. GitHub currently has no repository ruleset or branch
protection, so CI is not yet an enforced merge gate. Contributors must still
require green CI before merge or release.

Formal desktop releases use `.github/workflows/tauri-preview.yml`. Release
sources must contain the latest `origin/main`, and release tags must exactly
match `v<package.json version>`.
