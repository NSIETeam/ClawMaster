# @clawmaster/dsh-feishu-docs

Read-only Feishu (Lark) Docx/Wiki/Drive access for the ClawMaster agent, so it can read
company documents instead of only the messages that happen to reach the Feishu bot.

## Interface

Seven agent tools. Every one is L0 observe: **none requests approval, and this package
registers no write tool at all.**

| Tool | What it does | Feishu scope it needs |
|---|---|---|
| `feishu_whoami` | Reports the app identity (bot name, open id, activation). | bot |
| `feishu_capabilities` | Probes each read endpoint and names the scopes Feishu says are missing. | — |
| `feishu_doc_read` | Renders one docx document as Markdown. Accepts a token or a pasted URL. | `docx:document:readonly` |
| `feishu_wiki_spaces` | Lists the wiki spaces the app can see. | `wiki:wiki:readonly` |
| `feishu_wiki_nodes` | Lists a space's nodes, optionally under a parent node. | `wiki:wiki:readonly` |
| `feishu_wiki_read` | Resolves a wiki node to its document and renders it. | `wiki:wiki:readonly` |
| `feishu_drive_list` | Lists files and folders in a cloud-drive folder. | `drive:drive:readonly` |

Two authenticated Fetch routes expose the diagnostics to a UI: `GET
/api/clawmaster/feishu/whoami` and `GET /api/clawmaster/feishu/capabilities`. The DSH
Fetch carrier owns authentication and origin checks.

`feishu_capabilities` exists because "no documents" and "no permission" look identical
from the outside. A missing scope is reported with the exact scope list Feishu returned,
and an identity-lookup failure is reported in `identityError` while the probes still run.

## Configuration

```yaml
- id: clawmaster-feishu-docs
  name: '@clawmaster/dsh-feishu-docs'
  config:
    appId: cli_xxxxxxxxxxxxxxxx
    appSecretRef: DSH_FEISHU_APP_SECRET_XXXXXXXX
    # domain: feishu | lark        (default feishu)
    # timeoutMs: 20000
    # maxRetries: 3
```

`appId` and `appSecretRef` deliberately have no defaults: the Feishu app belongs to the
deployment's tenant, so both are configuration and never constants.

`appSecretRef` names a reference in the DSH credential store, injected as
`ctx.credentials`. The secret is resolved on demand at each tenant-token acquisition and
is never stored on the client, put in a prompt, or written to a log. The client caches
only the short-lived tenant token it derives, so a rotated secret is picked up at the
next refresh.

## Required Feishu scopes

The app must be granted these read scopes and the version published before document
reads work. Without them every document endpoint answers `99991672`:

```
docx:document:readonly
wiki:wiki:readonly
drive:drive:readonly
contact:contact.base:readonly   (optional)
```

## Layout

- `src/errors.ts` — error taxonomy: missing scope, auth, throttle and config failures are
  separate types so a missing permission is never mistaken for an empty document.
- `src/client.ts` — tenant-token cache and single-flight, bounded retry with backoff,
  page-token traversal with a guard against a server that echoes one token forever.
- `src/markdown.ts` — docx blocks to Markdown, walking the page/children tree. A block
  type the renderer does not understand becomes an explicit HTML comment, so a lossy
  conversion is always visible.
- `src/resources.ts` — docx, wiki and drive readers plus the capability probe.
- `src/protocol.ts` — route paths, argument schemas, and document-token extraction.
- `src/host.ts` — the cordis plugin: `inject = ['connection', 'tools', 'credentials']`,
  route and tool registration, and cleanup on unload.
- `tests/` — client lifecycle, Markdown rendering and the host surface, run with
  `node --import tsx/esm --test`.

Host half only: this capability has no UI surface, so no client bundle is built and the
package declares no `dsh.client`.

## Known gaps

- **No space or folder allowlist yet.** Every read is currently bounded only by what the
  Feishu app itself can see. A default-deny allowlist over wiki spaces and drive folders
  is planned, together with an audit record per read.
- **Code fences carry no language tag.** `code.style.language` is an enum whose values are
  not yet verified against a real document, so no mapping is asserted.
- **Direct `feishu_doc_read` cannot be space-scoped** from a bare token: a document token
  does not carry its wiki space. Such reads are governed by the app's own Feishu
  permissions.
