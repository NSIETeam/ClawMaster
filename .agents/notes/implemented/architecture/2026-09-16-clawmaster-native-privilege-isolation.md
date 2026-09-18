# Agent Note: ClawMaster native privileges belong to packaged WebViews

Status: implemented

English | [中文](2026-09-16-clawmaster-native-privilege-isolation.zh.md)

## Problem

A desktop window contains both a packaged shell and a separate authenticated Host WebView. Window-wide permissions include child WebViews, while a localhost wildcard also identifies unrelated listeners. Document content must not inherit native commands through either rule.

## Decision

The [capability](../../../../apps/desktop-tauri/src-tauri/capabilities/default.json) matches only the packaged `main` WebView and grants window dragging plus the three shell commands registered by the application build manifest for Tauri ACL enforcement. The `splash` WebView, Host content and preview frames receive no native permissions. The [navigation validator](../../../../apps/desktop-tauri/src-tauri/src/webview_security.rs) requires a numeric loopback HTTP address with an explicit port and keeps the main Host view on that exact origin. New-context HTTP(S) references without embedded credentials open through the default browser; loopback listeners and executable protocols are refused. Only the exact same-origin Office notice path, without query parameters, may create a separate authenticated document view. Its label matches no native capability and navigation remains on the notice path.

The [packaged-page CSP](../../../../apps/desktop-tauri/src-tauri/tauri.conf.json) defaults to denying resources and permits same-origin scripts, styles and images, with connections limited to Tauri IPC. The shell and splash pages load local script and stylesheet files; the policy grants neither `unsafe-inline` nor `unsafe-eval`. Frames, object embeds, form actions and base-URL overrides are denied. This policy does not replace the separate Host's web-resource policy or DSH tool permissions. The [runtime-governance decision](2026-09-13-clawmaster-runtime-governance.md) retains execution-policy ownership; plugins remain trusted code with Host-process authority.

## Entry-point threat surface

| Entry point | Allowed authority | Enforced restriction | Evidence and limit |
| --- | --- | --- | --- |
| Packaged `main` shell | Window dragging and the three registered shell commands | The only capability targets WebView `main`; packaged resources use the exact CSP above | Capability and CSP source tests; installed WebView behavior still needs platform acceptance |
| `splash` WebView | No native command | It has no matching capability and uses the packaged-page CSP | Capability and page-resource tests; platform behavior remains unverified |
| Authenticated Host WebView | Host HTTP content and its DSH tools | Separate WebView; exact numeric loopback HTTP origin and port; no native capability | Rust URL unit tests; they do not constrain every action in MCP, Office, or RPA providers |
| Office notice document view | Display of the exact same-origin notice | No native capability; exact notice path and no query; navigation remains on that path | URL classifier tests; cross-platform document rendering and file side effects remain unverified |
| External browser handoff | External credential-free HTTP(S) references | Loopback and local names, embedded credentials, and executable schemes are rejected before launch | URL classifier tests; OS browser behavior is outside the app's enforcement |
| In-process plugins | Their Host-process authority | WebView ACL does not isolate plugins loaded into the Host process | Trusted-code assumption only; malicious same-process plugin containment is not implemented |

The desktop profile's read-only sandbox and ask-for-approval defaults govern DSH tool execution for a fresh profile; they do not prove that every integration routes all effects through those controls. Existing user settings are retained. Cross-platform real-file side effects, complete MCP/Office/RPA mediation, and hostile same-process plugin isolation are not accepted by these source checks.

## Alternatives considered

**Grant permissions to the parent window or localhost wildcard.** These rules authorize child views or unrelated listeners. The [native-window decision](../feature/2026-09-13-clawmaster-native-window-titlebar.md) already assigns dragging and controls to native decorations.

**Allow inline resources for progress updates.** Local script and stylesheet files provide the packaged pages' behavior and appearance; progress updates assign style properties from the local script. They do not require a general inline-resource exception.

## Consequences

Host content cannot invoke shell lifecycle commands. The native callback selects the browser or the unprivileged Office notice view from parsed URLs; it does not expose an arbitrary launcher command. Launcher failures omit the URL from logs because queries can contain private data. Future native actions need explicitly reviewed capabilities. An arbitrary malicious Host plugin is not isolated by WebView ACL.

Rust URL tests reject wrong ports, origins, credentials and non-HTTP targets. The actual application ACL compiles, and policy tests reject window-wide or remote grants. These source checks do not establish installed WebView behavior across platforms; packaged native interaction remains a separate acceptance requirement.
