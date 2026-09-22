# ClawMaster system defect register — kernel codename Dawn

English | [中文](DEFECTS-DAWN.zh.md)

**Baseline**: desktop 0.0.1beta · dsh 0.1.5-rc.2 (harness `72da6c767414dd30`) · repository `main` at `5566bec824af45290596e50f938c880ae154aedf`, plus the Issue #32 task branch

**Updated**: 2026-09-22

---

## 1. Root-caused (verified on this machine)

| # | Defect | Root cause | Fix |
|---|---|---|---|
| F1 | WeChat channel replied `INTERNAL_UNKNOWN` to everything | Environment residue (old plugin copies under profiles/node_modules) + corrupted session history | Residue cleanup + session reset (runbook in `~/ClawMaster/memory/`) |
| F2 | One bad session vetoed all history loading | Context injections wrote `user/message` without `role/id/source`; the validator is strict | 21 sessions / 93 events repaired; `session-doctor.mjs` self-heals every 30 minutes (launchd) |

## 2. Open defects (Dawn kernel)

| # | Defect | Impact | Mitigation | Root fix |
|---|---|---|---|---|
| D1 | **Session-scan veto**: `WorkspaceRegistry.listStoredHeaders` used to fail wholesale on any bad session | One bad session could hide all history | **Fixed**: per-session quarantine isolates corrupt entries | [#14](https://github.com/NSIETeam/ClawMaster/issues/14) |
| D2 | **Context injections wrote events with missing fields**: skill-catalog replays / Graph Memory recalls could append `user/message` without `role/id/source` | Kept producing bad sessions (the source of D1) | **Fixed**: write-side append healing; the focused session suite passes 77 tests | [#15](https://github.com/NSIETeam/ClawMaster/issues/15) |
| D3 | **Runtime integrity restore**: files under `harness-versions/` are restored to pristine; any runtime patch is lost on restart/maintenance | The read self-heal patch does not persist | Once the kernel is upgraded, the patch is no longer needed | Upgrade the dsh kernel |
| D4 | **Concurrency lock conflict**: headless/probe processes and app startup can hold the `graph.sqlite` write lock concurrently | notes/graph-memory plugin init failures can be rescue-disabled | **Fixed at the known source**: `busy_timeout` landed; avoid concurrent probes while validating constructor-level behavior | [#17](https://github.com/NSIETeam/ClawMaster/issues/17) |
| D5 | **Overlay config rewritten**: `desktop-overlay/cordis.yml` is rewritten back to the template by the app at every boot | Custom plugins lost | Custom plugins go in the user layer `~/.dsh/cordis.patch.yml` (never rewritten) | The app preserves user inserts |
| D6 | **ZCode-hosted finance MCP plugins unusable** — kernel already supports streamable-http; the block is the ZCode paid-plan permission (probe: gateway reachable, JWT recognized, JSON-RPC 1006 "no permission") | 4 plugins (Hexin/Wind/Tianyancha/finance search) need a ZCode plan carrying finance MCP | Upgrade the ZCode plan, then wire via streamable-http (url + Bearer); or install ClawMaster-hosted equivalents | [#19](https://github.com/NSIETeam/ClawMaster/issues/19) |
| D7 | **Browser launch 400 regression**: `browser-open.spec.ts` expected 200, got 400 | Stale test fixture: the dist index lacked `<head>`, required by CSP-nonce rendering — not a product regression | **Fixed on the Issue #32 branch**: the fixture now has valid HTML and the focused browser test returns 200 | [#20](https://github.com/NSIETeam/ClawMaster/issues/20) |
| D8 | **Hardcoded version drift**: version literals scattered across server.ts / browserPreviewBridge / enterprise bin.ts | Version-consistency gate red | **Fixed**: all literals aligned to the root package.json (gate green); single-source injection remains the long-term fix | [#21](https://github.com/NSIETeam/ClawMaster/issues/21) |
| D9 | **Snapshot-only gate tests**: `scripts/tests/*.test.js` and their enterprise/E2EE production sources exist on `dsh-workline`, not on the current repository `main` | Copying the tests alone would create false gates for absent product code | Keep the snapshot coverage in its owning line; port production code and tests together if that feature is promoted | [#22](https://github.com/NSIETeam/ClawMaster/issues/22) |
| D10 | **Lint debt**: the historical snapshot reported large style debt | Repository-wide lint remains the authoritative current signal | Do not carry the stale count forward; address current lint findings by package | [#23](https://github.com/NSIETeam/ClawMaster/issues/23) |
| D11 | **Skill-catalog selection noise**: 134 catalog entries; the model initially shallow-matches on names and picks wrong | First selection may load the wrong skill | Skill-discipline system-prompt section + Chinese trigger phrases (probes pass 10/10) | Load skills by workspace area |
| D12 | **Rescue-disable was silent**: a plugin failing at startup could be rescue-disabled without a UI indication | The user did not know a capability was missing | **Fixed**: local-only runtime health reports disabled plugin names and the Home layer surfaces them | [#25](https://github.com/NSIETeam/ClawMaster/issues/25) |

## 3. Issue #32 correction: memory, notes, and knowledge graph

The current `main` already has a local Markdown vault with frontmatter, tags, daily notes, wiki links, backlinks, search, proposals/diffs, annotations, and approvals. Graph Memory already has typed nodes and edges, BM25 retrieval, unresolved-link tracking, and a persisted atomic graph snapshot. The remaining gaps are narrower but still important: the graph surface is not yet a real interactive graph, Notes search is scan-based, Graph Memory rebuilds a monolithic snapshot, and recovery/sync/templates/legacy `memory.md` migration are absent.

The proposed v2 architecture, corrected ten-dimension comparison, migration boundary, acceptance criteria, and OpenViking decision gate are recorded in [Obsidian-compatible knowledge vault v2](../.agents/notes/proposed/architecture/2026-09-22-obsidian-compatible-knowledge-vault-v2.md). This remains a **proposal**: the architecture must be reviewed before the schema, migration, or graph UI is implemented.

## 4. Closed items

- ~~`NSIETeam/ClawMaster` repository~~: deleted 2026-09-21 (cleaned up after archiving); the sole remote is `NSIETeam/ClawMaster` (renamed from ClawMaster-Desktop).
- The old product line (companyos, 208 commits) is preserved in tag `legacy/main-pre-dsh`; nothing was lost.


---

## Issue index

Every register entry is tracked on GitHub ([NSIETeam/ClawMaster](https://github.com/NSIETeam/ClawMaster/issues)):

| Entry | Issue | State |
|---|---|---|
| D1 session-scan veto | [#14](https://github.com/NSIETeam/ClawMaster/issues/14) | closed: listing quarantine in source (4596ec2755) + read-heal deployed to the field runtime |
| D2 injections missing fields | [#15](https://github.com/NSIETeam/ClawMaster/issues/15) | closed: write-side append heal (501/501) + read heal deployed to the field |
| D3 runtime integrity restore | [#16](https://github.com/NSIETeam/ClawMaster/issues/16) | open |
| D4 graph.sqlite lock conflict | [#17](https://github.com/NSIETeam/ClawMaster/issues/17) | closed: `busy_timeout` landed; constructor-level behavior remains a validation concern |
| D5 overlay rewrite | [#18](https://github.com/NSIETeam/ClawMaster/issues/18) | closed (user-layer patch verified) |
| D6 MCP stdio-only | [#19](https://github.com/NSIETeam/ClawMaster/issues/19) | open (marketplace native install pending) |
| D7 browser-open 400 | [#20](https://github.com/NSIETeam/ClawMaster/issues/20) | closed (stale fixture) |
| D8 version drift | [#21](https://github.com/NSIETeam/ClawMaster/issues/21) | closed (literals aligned) |
| D9 snapshot-only gate tests | [#22](https://github.com/NSIETeam/ClawMaster/issues/22) | closed on its owning snapshot; not present on current `main` |
| D10 lint debt | [#23](https://github.com/NSIETeam/ClawMaster/issues/23) | closed; current repository lint is authoritative |
| D11 skill-catalog noise | [#24](https://github.com/NSIETeam/ClawMaster/issues/24) | closed: discipline section (probes 10/10) + zh triggers + dev-skill cold storage (134→124) |
| D12 silent degradation | [#25](https://github.com/NSIETeam/ClawMaster/issues/25) | closed: local runtime health endpoint + Home-layer disabled-plugin names + native rescue logging |
