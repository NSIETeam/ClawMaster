---
description: "ClawMaster WatchDog desktop workspace, local data processing, CRM and inventory orders for users and maintainers of the Tauri frontend bundle."
kind: "package-bundle"
---

# ClawMaster WatchDog frontend

English | [中文](README.zh.md)

## Summary

ClawMaster brings tasks, document editing, browsing, terminals and local business records into one Tauri desktop workspace. Its slogan is “开启AI时代的企业协作”. The desktop includes this bundle and uses DSH for conversations, models, tools, approvals, plugins and session recovery. AI uses DSH tools to process CSV and query or prepare customer and order records. The panels support reviewing results, approvals and manual takeover. AI tasks use the configured DSH provider; manual actions require no model call.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the ClawMaster Tauri desktop application. Its provisioner includes this frontend and the plugins listed in the [desktop defaults](../../apps/desktop-tauri/README.md#architecture). The [desktop guide](../../apps/desktop-tauri/README.md) owns installer, runtime provisioning and launch instructions; this frontend package alone is not a desktop installer.

<a id="first-run-tutorial"></a>
### First-run tutorial

With no Session or Workspace history, WatchDog teaches a five-step management workflow using this week's customer follow-ups and delivery risks: define scope, write responsibilities and acceptance criteria, inspect CRM/ERP records and supplied documents, choose a review frequency and check approvals, then verify findings and follow up on corrective action. Business drafts store owners, deadlines and acceptance criteria as separate fields. The primary action opens WatchDog management; model and IM settings are auxiliary destinations at the end. Reading, skipping or replaying creates no task and sends no prompt or external message. Existing users can open Settings → WatchDog tutorial at any time.

Skip and finish record a versioned acknowledgement through DSH settings. The desktop keeps it across restarts and local port changes; newer acknowledgement versions are preserved. A refused write keeps the guide open with a retry message. Remote browsers retain acknowledgement only for the current settings-shell lifetime. Tutorial completion does not verify an API key, create a task, schedule a reminder or connect an IM account.

### Start a task or open a tool

Application startup creates no default workspace. With no session or workspace history, the first entry opens WatchDog; existing selections and subsequent navigation take precedence. Starting a WatchDog task allocates a directory under `$DSH_HOME/watchdog-workspaces/tasks/<uuid>` and uses the ordinary DSH session flow. Opening an editor, browser or terminal uses the current, unarchived session when available; otherwise the first tool request allocates `$DSH_HOME/watchdog-workspaces/desk` and creates or reuses its session. These directories and their files survive application restarts.

Workspace allocation checks the current `GovernanceAccess` identity and scoped `workspace.create` permission before creating directories. Missing identity, revoked membership or unavailable authority creates no directory; explicit local identity does not establish organization membership.

WatchDog keeps the task description and review frequency while you switch between settings, components and Sessions. Once a prompt is sent, an unconfirmed submission keeps its target Session and locks the goal and frequency. Retry the original request or open its Session to inspect it; retries reuse the exact prompt and request identity, including after a UI language change. Failures before sending leave the draft editable. Confirmed acceptance clears and unlocks the draft. Reloading the page or quitting discards an unaccepted task draft.

WatchDog home reports app-service connection, model verification, scheduled-worker observations and business-task attention separately. A durable `assistant/message` in a loaded Session event window records a successful model response; this does not prove current provider availability; schedule status uses the latest timestamped worker response; business counts cover only the task page currently loaded. Missing observations and read failures remain explicit. Management prioritizes durable tasks awaiting review, failed or overdue. Drafts record a goal, scope, owner, deadline, risk and acceptance criteria; an existing Session can be explicitly selected as their source. Starting a ready task saves its selected Session and request identifier, then submits the complete goal, scope, owner, deadline, risk and acceptance criteria to that Session. The browser can record only uncertainty; a Host observer correlates the durable Session request id with its turn and records failure for a claimed request that ends unsuccessfully or is canceled from the inbox. Success requires a matching persisted `user/message`, so an empty pre-step that ends `completed` does not count as execution. Host replay flushes a live Session before reading its durable log, reconstructs inbox requests and cancellation, and restores active turn correlations after an observer reload. A completed DSH turn confirms execution, not business acceptance. If admission is uncertain, the task can retry the same request identifier and exact brief; a terminal replay result prevents another prompt submission. Linking a Session alone sends no model request. In-progress work can record waiting conditions, failures or evidence submissions. Humans enter a comment to accept or reject results, and closed tasks can be reopened. Paged history preserves prior submissions and reviews. Evidence references are marked unverified and require inspection of their sources.

Business writes use revisions to prevent overwriting another change. List refresh preserves the revision open in task details; after a conflict, reopen and inspect the current record. An uncertain save pauses other writes and retries the original command and idempotency key. Pending requests survive panel navigation; after reloading the page or quitting, inspect persisted records before continuing. The Session list below prioritizes Sessions awaiting approval, an answer or plan review and can filter to those requiring attention. Open the original Session to respond. Running and idle labels report execution activity; neither certifies that the business objective is complete.

To choose a workspace directory manually, use **Add workspace** in the workspace header. The directory browser opens inside ClawMaster. Browse folders, enter a path or create a folder, then choose **Open** to use the selected directory.

WatchDog occupies the main panel. Better Sidebar opens document editing, browsing, CRM and ERP in tabs beside the conversation, and terminals at the bottom. Manage CRM and ERP with the other components in Settings → Side Cards; each component's feature settings opens its right-side tab. Components are enabled by default but open only on request. Opening an existing component selects its tab.

Visiting a global panel such as WatchDog preserves the current Session's right-side editor and browser instances, including unsaved text and iframe documents. Hidden docked and floating content takes no frame width or keyboard focus. Save before switching Sessions, closing tabs or quitting. The [desktop compatibility patch](../../apps/desktop-tauri/README.md#architecture) also retains browser navigation per native Session and tab identity; it does not persist editor drafts.

| Module | Use |
| --- | --- |
| Documents | Edit text and code, and preview files in the session workspace. |
| Browser | Open websites in Better Sidebar's sandboxed browser panel. |
| Terminal | Use a terminal associated with the session workspace. |
| CRM | Maintain contacts, companies, stages, next actions and follow-up dates. |
| ERP | Maintain SKUs, stock, reorder thresholds, suppliers and purchase/sale orders. |

### Give AI a business task

Describe the goal in a task and place its input files in that task's workspace. For example: “Trim and deduplicate customers.csv, save customers-clean.csv, then query CRM and organize contacts needing follow-up.” AI calls the built-in business tools directly. CRM and ERP components provide review and manual controls; the file editor opens CSV results. Data processing has no separate panel or navigation entry.

### Prepare CSV or TSV data

Ask AI to process a workspace file with explicit delimiter, header, trim, duplicate removal, blank-record removal, substring filter and sort rules. Parsing preserves cell text, including leading zeros. Invalid quoting or inconsistent column counts block processing and output until the source is corrected.

The tool's default input limit is 16 MiB and its result preview contains at most 10 rows. Saved CSV includes every processed row with a UTF-8 BOM. Spreadsheet formula protection is enabled by default and prefixes formula-active cells with a single quote. DSH records the tool's result and saved file path in the conversation.

### Save contacts, stock and orders

CRM and ERP start with an empty database at `$DSH_HOME/watchdog/enterprise.sqlite`. Saved records are independent of the browser origin, random Host port and selected session. Contact and SKU edits and deletions are audited. Existing browser `localStorage` records are neither deleted nor automatically imported into SQLite.

Save purchase or sale orders as drafts with quantities and unit prices. Submitting a purchase adds stock; submitting a sale subtracts stock. All lines, order status, the revision and before/after audit facts commit together. Insufficient stock rolls back the entire submission. Submitted orders cannot be edited, deleted or applied twice.

Stock and quantities use safe integers; monetary values use integer CNY minor units. A SKU referenced by an order cannot be deleted. Unsupported, foreign or damaged databases fail without an automatic reset.

Contact, stock and order forms save against the revision captured when editing begins. A shared record refresh preserves your input and shows current values when the revision changes; saving remains disabled until you explicitly confirm that you have reviewed them and want to keep the whole draft. This action does not merge fields automatically. A deleted record or submitted order cannot be resumed for editing. A changed revision invalidates a deletion or submission confirmation; cancel and reopen it before proceeding. Uncertain saves retain their command identity for an explicit retry.
The CRM and ERP headers provide **Download local data backup**. A read-only worker streams records and command receipts from one SQLite snapshot into a bounded private file; the browser downloads that JSON file without parsing its complete contents. Portable format 1 covers enterprise records only, not Sessions, Skills, profiles, tasks or other DSH home data.

Select a JSON backup to upload the original file, inspect its validated counts and digest, then confirm the current revision and restore generation. Preparation has a byte limit, expires after five minutes by default and is bound to the authenticated caller. The Host consumes the exact approval before giving its worker a database write target, checks the current versions inside the transaction and rechecks membership before COMMIT. Cancellation waits for worker exit and transaction rollback; if COMMIT already succeeded, the durable receipt establishes success. A restore increments the database-local generation, invalidating older writes and pages even when revisions repeat.

A missing or invalid restore response preserves the exact request and command identifier and blocks further writes. Use **Check this restore outcome** to retry that request: the Host returns its persisted receipt without importing again, including after the prepared file expires. Refreshing alone does not resolve this uncertainty. Keep the application open until the result is known; pending requests are not persisted across a browser reload.

Forms and confirmations opened before a restore keep their original generation. Their inputs remain visible, but refreshing or editing them does not authorize a write to restored records. Explicitly review current records to retain a form draft, or cancel and reopen it. Deletion and submission confirmations must be reopened.

The schema 3 migration adds responsibility history outside business snapshots. Business writes and restore success records commit in the same transaction; audit failure blocks the write. Restoring an old backup preserves responsibility records for changes made after that backup. Records contain Host-derived actor, carrier, Session/call, approval reference, policy version, revisions, outcome and backup digest, without contact or order contents. Historical receipts imported from schema 1/2 explicitly have an unknown actor. The authenticated `/api/clawmaster/enterprise/responsibility` route filters by actor, command, entity or operation and returns `{ records, nextAfter }` within configured row and complete-response byte limits. Send `nextAfter` as `after` to continue; individual records are never truncated. An oversized record fails with `result_too_large` and remains available after increasing the read budget. Supplying `commandId` with a restore makes an identical retry idempotent. Append-only triggers and a verified hash chain detect local inconsistency; a machine administrator can replace the database, so enterprise retention requires a separate trusted archive. Responsibility history has no automatic retention deletion and is not included in portable business backups. Records for authenticated authorization failures and task failures contain only operation metadata and fixed reason codes; approval denial, cancellation and failure remain distinct. Missing, unbound or foreign-organization identities never acquire a local-human attribution.

Database creation and upgrades commit schema changes, organization binding, history import and schema version together. A refused organization change or integrity failure rolls back that transaction; opening the same schema 1 database in local mode remains possible after a refused enterprise migration.

### Business task and identity interfaces

Record, task and schedule commands share `governanceCommands` admission across HTTP and tools. HTTP routes resolve identity before reading a streaming JSON body, count actual UTF-8 bytes even without a length header, and stop an idle upload at the configured deadline. The carrier sends a structured refusal before closing an unread request. Tool arguments are byte-checked after DSH JSON decoding and before domain validation or approval. Capacity stays reserved through approval and commit; reads remain available. Input excess returns HTTP 413, capacity exhaustion 503 and upload timeout 408. A timeout or unavailable response retains the original command for exact retry. The upload deadline does not limit a subsequent human approval wait.

Governance consumers pass request and plugin-lifetime cancellation into identity, membership and approval calls. Cancelled calls cannot continue authorization when a provider later responds; the authority receives the same signal to stop its own work. Cancellation does not undo an approval already consumed externally.

The Host option `watchdogTasks.maxResponseBytes` sets the UTF-8 budget for complete task responses, including the DSH structured value and rendered text; it defaults to 65536 and accepts integers of at least 1024. `watchdogTasks.outcomeRetryMs` sets the wait between retries after a transient task execution audit storage failure; it defaults to 1000 and accepts integers from 10 to 60000. The Host retries until it records the observed result or unloads; a remounted Host replays the durable Session log. Writes that would exceed the response budget fail before committing a task, history row or success receipt. Lists prioritize pending review, failure and overdue work, then other tasks; each page returns `{ tasks, nextCursor }`. Pass the unchanged cursor as `cursor` (JSON-encoded in HTTP) to continue the same collection version and urgency time; writes invalidate prior cursors with `revision_conflict`. History returns `{ tasks, nextAfter }`: send `id`, `history=true`, `after` and `limit` to continue immutable revisions. Both pages may return fewer records than requested to fit the byte budget. The browser retains one list page and one history page; refreshing a list or reopening history returns to its first page without advancing an open task revision. Oversized existing records fail explicitly with `response_too_large` (HTTP 413), without truncating or rewriting data. The browser and Host share Node-free validation in [watchdog-task-format.ts](src/watchdog-task-format.ts).

`watchdog_task_query` and `watchdog_task_command` manage durable tasks with an owner, deadline/timezone, risk, scope, acceptance criteria, evidence and linked DSH Sessions. Business states are draft, ready, in progress, awaiting review, accepted, failed and cancelled. Waiting and overdue indicators are independent of Session activity. Agents submit evidence and cannot accept, reopen or cancel tasks. Human rejection returns work to ready while preserving previous evidence and review history. Commands carry a task revision and idempotency key; explicit Session imports create drafts and never infer past success. `/api/clawmaster/tasks` reads a page, an `id`, or its `history=true`; `/api/clawmaster/tasks/command` accepts the shared command envelope. These records are excluded from CRM/ERP restore. Evidence references are explicitly unverified until a human checks the location; the Host does not fetch arbitrary evidence URLs.

Local mode identifies a device operator and uses explicitly labelled local owners. An embedding Host may configure `governance: { mode: 'enterprise', organizationId, authority }` using the trusted `GovernanceAuthority` interface in `src/governance-access.ts`. That authority must authenticate HTTP requests independently of the DSH desktop token, bind agent Sessions to initiating members, read current membership on each operation and consume object/revision/digest-bound approvals. Each database is bound to one organization; an existing local database cannot silently become enterprise data. Every route, tool and schedule runtime checks that its database owner matches the configured organization before registering or running. Schedule consumers check both their ledger and responsibility database. The reserved `local` namespace requires local mode; a deployment mismatch fails without exposing those consumers. HTTP and tool consumers check the same roles and resource grants, including after approval waits. Delegated grants cannot exceed the initiating member's grants. New or revised task owners are checked again after independent approval. Every enterprise record mutation, task write and restore requires a different active approver; task result review is performed directly by an authorized human, and a submitting member cannot accept their own result. Local DSH tool approval records only the `dsh-one-shot` outcome; DSH supplies no independent approver identity or approval ID. Committed task retries require current access and exact caller/content matching without consuming another approval. An unavailable authority fails the operation without local fallback.

The enterprise overview contains versions, collection counts and configured page limits; it requires organization-wide record and audit read access. Every HTTP write returns only command receipt metadata, including in local desktop mode. Resource-scoped readers use `/api/clawmaster/enterprise/query` or `enterprise_query` with an authorized record ID; audit reads require their own permission.

The Host validates every non-empty response from `GovernanceAuthority` at the provider boundary. A malformed HTTP or Session principal, membership, owner membership or approval response fails closed as service unavailability and cannot become a local operator or an enterprise denial. A missing response remains an ordinary unauthenticated or unapproved result. This distinction prevents a broken identity provider from granting access while keeping provider details out of HTTP errors and responsibility history.

| Role | Allowed actions |
| --- | --- |
| Administrator | Read/write records and tasks; export, restore and inspect audit; human task review |
| Executor | Read/write records and tasks within granted resources |
| Approver | Read records/tasks and review task results; approve exact enterprise commands |
| Auditor | Read records/tasks, export backups and inspect responsibility metadata |

The authority interface is an integration requirement, not a bundled identity provider or a claim of a validated multi-user deployment. Organization login, identity-provider integration, attachment serving, explicit local-to-enterprise migration and the real desktop acceptance flow require deployment-specific integration. External CRM/ERP connectors are separate capabilities.

### Use reminders and IM connections

The bundle enables DSH's official Schedule, time context and reminder catalog. The Session reminder frequency control asks AI to create a reminder; only its successful tool result confirms creation. Product-level persistent plans use the separate Scheduled checks panel. Reminder delivery needs the application running and a live root agent in the owning session; closing the application does not create an operating-system background scheduler. Due reminders return to the same conversation when that session can accept them. See the [Schedule guide](../../docs/user/guide/schedule.md) for supported timing and recovery behavior.

WatchDog management exposes product-level persistent plans through the Scheduled checks panel. It provides per-occurrence approval, independently observed worker state and human resolution of uncertain delivery. An active plan with no online worker raises an in-app alert after a status read; the alert does not reach the operator while the host is offline. See [persistent scheduling](scheduling/README.md) for the workflow, authenticated interfaces, deployment limits and recovery.

IM account setup and platform login flows belong to the bundled IM plugin. Including the plugin does not establish a live Feishu, WeChat, WeCom or DingTalk connection; each platform's account conditions and connection result must be verified in its settings.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation and contributor checks — click to expand</summary>

The sidebar and conversation hero render the transparent [light SVG](src/clawmaster.svg) or [dark SVG](src/clawmaster-dark.svg) through the client bundle's SVG data URL loader. CSS follows DSH's resolved `body[data-ds-dark-theme]` state, including manual theme choices and system-following mode. The [desktop asset guide](../../apps/desktop-tauri/README.md#release) owns splash, favicon and native icon distribution; [the PNG](src/clawmaster.png) is retained only as a visual reference.

The [profile patch](cordis.patch.yml) disables the official brand and adaptive directory-picker rows, inserts this frontend and DSH's browse directory-picker backend and surface, enables Schedule and time context, and enables the reminder UI. The DSH Web bundle already supplies both browse packages. The [client entry](src/client.tsx) uses DSH's existing slots, theme, sessions, workspaces and panel services. The [Host entry](src/host.ts) registers lazy workspace allocation and enterprise routes on the existing authenticated DSH Fetch carrier; it starts no second server.

[PapaParse processing](src/business.ts) owns CSV syntax and serialization. [Enterprise storage](src/enterprise-host.ts) uses Node's SQLite and transactions; the HTTP routes and [AI tools](src/enterprise-tools.ts) share one store, command validation and revision checks. DSH's settings store remains configuration storage. Enterprise data does not enter the model automatically. The [enterprise decision](../../.agents/notes/implemented/bug-fix/2026-09-13-enterprise-reviewed-writes-and-bounded-queries.md) explains approval ownership, reviewed revisions and targeted reads. The [WatchDog request decision](../../.agents/notes/implemented/bug-fix/2026-09-13-watchdog-task-admission-and-attention.md) explains draft lifetime and pending-interaction projection.

Browser and AI queries select one SQLite collection, bind filters and paginate rows in SQL. Literal Unicode case-insensitive search covers text columns and order item IDs; audit search also covers stored before/after JSON. Matching counts can scan the selected collection. Sort and association indexes avoid full JSON construction during search; unfiltered audit continuations select an indexed revision range. Startup validates every record, audit revision, reference and responsibility hash by iteration, without a complete snapshot. Approval preparation reads only the target and referenced stock; all ordinary saves and retries return one durable receipt.

`GET /api/clawmaster/enterprise` returns `{ generation, revision, counts, limits }`; `/query` accepts `collection`, `offset`, `limit`, both version fields and optional `id`, `search`, contact `stage`/`dueBefore`, inventory `lowStock` or order `kind`/`status`. Pages return `{ generation, revision, collection, offset, total, nextOffset, records }`. Every continuation requires both versions; edits or restores return `revision_conflict` rather than mixing datasets. The browser retains one page per visible list and resolves off-page editor records and SKU choices separately. Saving validates a receipt before refreshing counters; refresh failure does not revoke confirmed success. Whole-record byte limits apply to pages and newly committed audit entries: an oversized change rolls back with `result_too_large` (HTTP 413). Existing oversized data is preserved and requires an increased read budget.

`GET /backup` streams format-1 JSON; `POST /backup/prepare` accepts a raw JSON file and returns a token, digest, versions and counts. `POST /restore` accepts only that token, digest, reviewed versions, a stable command identifier and explicit confirmation, returning a small durable receipt. The Host enforces upload bytes before parsing, bounds concurrent ingress, removes expired files and drains workers before closing storage. Restore rebuilds full-text indexes inside the record transaction; cancellation and failure roll back both records and indexes. Host and browser artifacts must deploy together.

The Host plugin accepts these optional settings through its Cordis configuration. Storage paths must be absolute.

| Setting | Default |
| --- | --- |
| `managedRoot` | `$DSH_HOME/watchdog-workspaces` |
| `databasePath` | `$DSH_HOME/watchdog/enterprise.sqlite` |
| `busyTimeoutMs` | `5000`; SQLite writer-lock wait, from `0` to `60000` ms |
| `dataTools.maxInputBytes` | `16777216` |
| `dataTools.previewRows` / `previewColumns` / `previewCellChars` / `maxDiagnostics` | `10` / `8` / `120` / `10` |
| `enterpriseTools.maxQueryRows` / `maxQueryBytes` | `100` / `262144` |
| `enterpriseRead.maxPageRows` / `maxPageBytes` | `50` / `262144`; browser row limit ≥ 1 and UTF-8 byte limit ≥ 1024 |
| `enterpriseRead.maxResponsibilityRows` / `maxResponsibilityBytes` | `500` / `262144`; complete responsibility records and encoded response bytes |
| `governanceCommands.maxRequestBytes` / `maxConcurrentCommands` | `1048576` / `2`; command bytes and simultaneous HTTP/tool commands |
| `governanceCommands.readTimeoutMs` | `30000`; identity and body-read deadline, excluding approval waits |
| `enterpriseBackup.maxFileBytes` | `67108864`; input and exported JSON bytes |
| `enterpriseBackup.workerHeapMb` / `workerYoungHeapMb` | `192` / `4`; V8 old generation/semi-space limits per child process |
| `enterpriseBackup.maxConcurrentJobs` / `maxPreparedFiles` | `1` / `1`; includes slow upload bodies and active downloads |
| `enterpriseBackup.timeoutMs` / `preparedTtlMs` | `60000` / `300000` |
| `enterpriseBackup.chunkBytes` / `sqliteCacheKiB` | `65536` / `4096` |

With the repository's supported Node runtime and this package's dependencies installed, run these commands from this directory:

```sh
npm run typecheck
npm test
npm pack
```

The test command builds the client factory, Host bundle and private backup worker before running the package's focused tests. Real HTTP regressions leave refused uploads unfinished until the server sends a complete response and closes the socket, then verify admission with another HTTP request. Packing runs the same build and produces a local `.tgz`; the package is private. React and React DOM come from DSH's shared client runtime. Tool navigation commits the session view before opening a panel, so the panel's DSH seat is bound. The [desktop build](../../apps/desktop-tauri/README.md) includes the frontend artifacts in its runtime payload.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop installation and runtime](../../apps/desktop-tauri/README.md) — Tauri packaging, startup and platform behavior.
- [Profile composition](../../packages/boot/app-boot/README.md) — DSH bundle ordering and configuration.
- [Official Schedule](../../packages/schedule/schedule/README.md) — durable reminders and live-session delivery.
- [Enterprise records and commands](src/enterprise-types.ts) — the shared client/Host data definitions.

-----

<a id="model-experience"></a>
## Model Experience

The frontend registers `csv_process`, `enterprise_query` and `enterprise_command` through DSH's ordinary tool pipeline. CSV processing reads complete files inside the current Session workspace, returns bounded previews and counts, and optionally saves the full result. Existing outputs require a prior read and DSH's file-version guard. Write escalation uses normal single-use DSH approval and does not permit paths outside the workspace.

Enterprise queries return bounded pages with a generation, revision, matching count and continuation offset. Pagination refuses a stale revision; a single record exceeding the byte budget fails explicitly. Every new AI business mutation, including contact and order-draft saves, requires explicit one-shot DSH approval. Rejection, cancellation, unavailable approval or the `never` policy leaves records unchanged. Revision conflicts require rereading; identical committed commands return their original receipt only to the same authenticated organization, actor kind/ID and initiating principal, without another mutation or approval. Retries retain the complete reviewed command envelope. Receipts without recorded ownership, including imported backup audit history, cannot authorize retries; refresh the records before issuing a new reviewed command. Authenticated manual UI saves retain their user-initiated behavior. UI and AI operations use the same local database.

Tool calls and returned data enter the Session log and subsequent model requests through DSH. The database is not automatically copied into prompts. The recorded owner-local [business flow](tests/business-tool-flow.test.mjs) covers CSV-to-CRM tool results, one-shot CRM approval, persisted replay and unavailable ERP approval with a synthetic model. Schedule owns its reminder tools and follow-up messages.

The ClawMaster profile selects DSH `read-only` file access with `ask` approval for new Sessions. Workspace file writes require explicit single-use escalation; `never` approval denies requests requiring a decision rather than approving them. Saved user settings take precedence over profile defaults. Delegated Sessions intersect their captured file access with live ancestor permissions before model steps and tools; missing or cyclic ancestry permits only reads, and child approval remains `never`. DSH's canonical setters append any restriction to the Session log. Agent Teams defaults to three members with one delegation level; its existing service owns roster validation, including the Web planning route.

#### KV Cache effect

`runtime_status` reads desktop identity and source provenance with an observation time; it returns unavailable when the shell record does not identify this Host. Logged runtime context refreshes these facts at request assembly and treats remembered versions, paths, ports and permissions as historical. `runtimeGovernance` on the frontend Host row configures `maxRssMiB` (default: the smaller of 2048 MiB and one quarter of physical memory, with a 256 MiB floor), `maxConcurrentHeavyTools` (2), and `heavyToolPatterns` (shell, subagent, team, workflow and CSV tool names). DSH's monotonic guard rejects new matching tools at the Host RSS budget; dispatch rejects excess overlapping bodies and releases capacity after success, failure or cancellation. Status reads remain available. Background work registered with [DSH jobs](../../packages/jobs/jobs-local/README.md#use-this-package) retains its per-owner and process-wide capacity slot after the tool returns, until the producer settles. Job counts and tool budgets do not cap aggregate child-process memory, Office WebViews, external applications or work outside those services.

The frontend adds tool schemas, logged tool results and timestamped runtime context, without a separate model provider or system-prompt prefix. Changed observations and results affect the request suffix. DSH owns request assembly and cache handling.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

The constraints below apply to this frontend and its local records.

### Execution authority

The desktop shell's Tauri CSP permits scripts, styles and images only from its app origin and permits IPC only through Tauri's local IPC origins. The `main` WebView receives window-drag and close/restart commands; the Host content WebView receives no native commands. These rules constrain WebView content, not the Node Host or native process tree.

| Operation | Enforcing component | Limit |
| --- | --- | --- |
| CSV file reads and writes | DSH sandboxed filesystem, workspace containment, file observations and one-shot DSH approval for escalation | This does not constrain unrelated plugin filesystem calls. |
| CRM and ERP writes | DSH tools and `GovernanceAccess` at tool and HTTP entry points | Local identity is not organization identity; no external identity provider is composed by this frontend. |
| Shell and PowerShell | The DSH shell and subprocess providers selected by the composed profile | Guard string checks are advisory. The frontend does not add a universal kernel sandbox or network restriction. |
| MCP, Office and RPA | Each mounted plugin, Office WebView or native RPA provider | DSH does not mediate every side effect from extension code running with the Host user's permissions. |
| Plugin installation and network egress | DSH plugin/configuration and provider-specific controls | There is no frontend-wide managed-mode policy that restricts all plugin code or outbound connections. |

CSV escalation displays the exact input path, output path and output format in its DSH approval reason. The tool runtime snapshots arguments before the asynchronous approval request; a caller changing its original argument object cannot redirect the approved write. DSH sandbox modes govern the providers that consume them; they do not establish complete mediation for arbitrary same-process plugins. macOS, Linux and Windows native permission behavior has not been verified by this source test.

- The integration baseline is DSH `0.1.5-rc.2` with Cordis `4.0.2`. Compatibility covers the public services consumed here and the plugin combinations that are actually tested; it does not certify every DSH plugin.

- CRM and ERP are local single-user records, not a shared multi-tenant enterprise system or external ERP/CRM connectors. Audit history is retained in full. Backup transfer files and worker heaps have configured bounds; parsing and semantic validation still grow with history and may refuse a large import. V8 limits do not cap native allocations or the entire desktop process tree. [Measured capacity](benchmarks/README.md) records response sizes, elapsed times and memory; it is not an unrestricted capacity guarantee. Direct maintenance `store.backup()`/`store.restore()` calls remain synchronous and are not the production HTTP path. The data processor supports delimited text, not XLSX workbooks or a persistent spreadsheet service.

- This package has no standalone installer-size commitment. The Tauri shell, DSH, Node runtime and third-party components have separate packaging and license obligations; this package uses Apache-2.0.

- OpenViking Memory is installed but disabled by desktop defaults until connected. The [local service guide](../../apps/desktop-tauri/README.md#optional-local-openviking-service) owns macOS preparation, USER credentials and the external AGPL-3.0 server; the integration plugin uses Apache-2.0. Service health alone does not verify desktop memory capture or cross-Session recall.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Development verification context — click to expand</summary>

This checkout is undergoing desktop integration. Source tests and package builds are development evidence; they do not establish acceptance of a newly installed desktop, every module interaction, real model reminders or platform QR login. The desktop integration task owns those live checks before release.

</details>
