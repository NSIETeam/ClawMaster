# ClawMaster system defect register — kernel codename Dawn

English | [中文](DEFECTS-DAWN.zh.md)

**Baseline**: desktop 0.0.1beta (version reset 2026-09-21) · dsh 0.1.5-rc.2 (harness `72da6c767414dd30`) · this document tracks the locally stable running version
**Updated**: 2026-09-21

---

## 1. Root-caused (verified on this machine)

| # | Defect | Root cause | Fix |
|---|---|---|---|
| F1 | WeChat channel replied `INTERNAL_UNKNOWN` to everything | Environment residue (old plugin copies under profiles/node_modules) + corrupted session history | Residue cleanup + session reset (runbook in `~/ClawMaster/memory/`) |
| F2 | One bad session vetoed all history loading | Context injections wrote `user/message` without `role/id/source`; the validator is strict | 21 sessions / 93 events repaired; `session-doctor.mjs` self-heals every 30 minutes (launchd) |

## 2. Open defects (Dawn kernel)

| # | Defect | Impact | Mitigation | Root fix |
|---|---|---|---|---|
| D1 | **Session-scan veto**: `WorkspaceRegistry.listStoredHeaders` fails wholesale on any bad session | One bad session → all history invisible | session-doctor self-heal as the safety net | Per-session quarantine (the "one session = one plugin" strategy); the local branch already contains `isolate loader entry failures at boot` |
| D2 | **Context injections write events with missing fields**: skill-catalog replays / Graph Memory recalls append `user/message` without `role/id/source` | Keeps producing bad sessions (the source of D1) | doctor self-heal + runtime read self-heal patch | Kernel fix: `createUserMessage` defaults the role |
| D3 | **Runtime integrity restore**: files under `harness-versions/` are restored to pristine; any runtime patch is lost on restart/maintenance | The read self-heal patch does not persist | Once the kernel is upgraded, the patch is no longer needed | Upgrade the dsh kernel |
| D4 | **Concurrency lock conflict**: headless/probe processes and app startup hold the `graph.sqlite` write lock concurrently | notes/graph-memory plugin init failures get rescue-disabled → the UI task list empties (no UI error) | Avoid running probes concurrently with app startup; a restart recovers | Wait/retry on the plugin load lock |
| D5 | **Overlay config rewritten**: `desktop-overlay/cordis.yml` is rewritten back to the template by the app at every boot | Custom plugins lost | Custom plugins go in the user layer `~/.dsh/cordis.patch.yml` (never rewritten) | The app preserves user inserts |
| D6 | **MCP bridge supports stdio only** | 4 ZCode-hosted HTTP MCP plugins (Hexin/Wind/Tianyancha/finance search aggregator) cannot be used natively | Install natively from the ClawMaster plugin marketplace | MCP bridge gains the http transport |
| D7 | **Browser launch 400 regression**: `browser-open.spec.ts` expected 200, got 400 | Stale test fixture: the dist index lacked `<head>`, required by CSP-nonce rendering — not a product regression | **Fixed** (fixture carries `<head>`, test green) | [#20](https://github.com/NSIETeam/ClawMaster/issues/20) |
| D8 | **Hardcoded version drift**: version literals scattered across server.ts / browserPreviewBridge / enterprise bin.ts | Version-consistency gate red | **Fixed**: all literals aligned to the root package.json (gate green); single-source injection remains the long-term fix | [#21](https://github.com/NSIETeam/ClawMaster/issues/21) |
| D9 | **Orphan gate tests**: `scripts/tests/*.test.js` were in no vitest include | CI never ran the release gates | **Fixed**: `testIncludes` now carries `scripts/tests/*.test.js` | [#22](https://github.com/NSIETeam/ClawMaster/issues/22) |
| D10 | **Lint debt**: 64k style errors in the snapshot directories (semi/indent etc.) | `pnpm lint` red repo-wide | Does not block the build | `oxlint --fix` bulk cleanup |
| D11 | **Skill-catalog selection noise**: 134 catalog entries; the model initially shallow-matches on names and picks wrong | First selection may load the wrong skill | Skill-discipline system-prompt section + Chinese trigger phrases (probes pass 10/10) | Load skills by workspace area |
| D12 | **Rescue-disable is silent**: a plugin failing at startup gets rescue-disabled with no UI indication | The user does not know a capability is missing (D4's symptom, amplified) | None | UI notification + health panel |

## 3. Closed items

- ~~`NSIETeam/ClawMaster` repository~~: deleted 2026-09-21 (cleaned up after archiving); the sole remote is `NSIETeam/ClawMaster` (renamed from ClawMaster-Desktop).
- The old product line (companyos, 208 commits) is preserved in tag `legacy/main-pre-dsh`; nothing was lost.


---

## Issue index

Every register entry is tracked on GitHub ([NSIETeam/ClawMaster](https://github.com/NSIETeam/ClawMaster/issues)):

| Entry | Issue | State |
|---|---|---|
| D1 session-scan veto | [#14](https://github.com/NSIETeam/ClawMaster/issues/14) | open (mitigated: session-doctor) |
| D2 injections missing fields | [#15](https://github.com/NSIETeam/ClawMaster/issues/15) | open — read-time heal landed in source, ships with next build |
| D3 runtime integrity restore | [#16](https://github.com/NSIETeam/ClawMaster/issues/16) | open |
| D4 graph.sqlite lock conflict | [#17](https://github.com/NSIETeam/ClawMaster/issues/17) | open (documented no-concurrent-boot rule) |
| D5 overlay rewrite | [#18](https://github.com/NSIETeam/ClawMaster/issues/18) | closed (user-layer patch verified) |
| D6 MCP stdio-only | [#19](https://github.com/NSIETeam/ClawMaster/issues/19) | open (marketplace native install pending) |
| D7 browser-open 400 | [#20](https://github.com/NSIETeam/ClawMaster/issues/20) | closed (stale fixture) |
| D8 version drift | [#21](https://github.com/NSIETeam/ClawMaster/issues/21) | closed (literals aligned) |
| D9 orphan gate tests | [#22](https://github.com/NSIETeam/ClawMaster/issues/22) | closed (vitest include) |
| D10 lint debt | [#23](https://github.com/NSIETeam/ClawMaster/issues/23) | open (deferred to kernel merge) |
| D11 skill-catalog noise | [#24](https://github.com/NSIETeam/ClawMaster/issues/24) | open (mitigated: discipline section, probes 10/10) |
| D12 silent degradation | [#25](https://github.com/NSIETeam/ClawMaster/issues/25) | open |
