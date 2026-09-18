---
description: "Opt-in personal WeChat and Official Account MCP configuration, approvals, prerequisites, and verification limits."
---

# WeChat integrations

English | [中文](README.zh.md)

## Summary

These source-checkout overlays connect personal WeChat and Official Account drafts through the existing MCP client. Neither integration starts by default. Every supported call requires one-time approval, including reading chats and listing themes. These files are not an installed desktop release or a new settings screen.

## Table of Contents

- [Choose and configure](#choose-and-configure)
- [Safety and failures](#safety-and-failures)
- [Verification](#verification)

<a id="choose-and-configure"></a>
## Choose and configure

Use [personal.cordis.yml](personal.cordis.yml) for [BiboyQG/WeChat-MCP](https://github.com/BiboyQG/WeChat-MCP), MIT, `wechat-mcp-server==0.2.0`. The upstream project supports recent-chat reading, replies, contact requests and text-only Moments through macOS Accessibility. It is Alpha software, not a full-history database API. The operator supplies macOS, Python 3.12 or newer, `uvx`, a logged-in WeChat desktop client, and any required Accessibility/Screen Recording permissions. Do not disable macOS security to enable it.

Use [official.cordis.yml](official.cordis.yml) for [caol64/wenyan-mcp](https://github.com/caol64/wenyan-mcp), Apache-2.0, `@wenyan-md/mcp@2.0.3`. The upstream project renders Markdown, uploads media and saves articles to the Official Account draft box; `publish_article` does not mean public publication. The operator supplies Node/npm, `WECHAT_APP_ID` and `WECHAT_APP_SECRET` in the local launcher environment, and an outbound IP permitted by the Official Account backend. Do not put credentials in prompts, committed overlays or command arguments. The overlay uses local stdio, not a third-party hosted service.

The source CLI accepts both overlays through repeatable `--patch`; use the same arguments with one overlay to enable only that account type. This inspection command composes configuration without starting either server; its output may contain credentials, so keep it local:

```sh
pnpm dsh --profile web --patch apps/cli/config/examples/wechat/personal.cordis.yml --patch apps/cli/config/examples/wechat/official.cordis.yml --dump-config
```

Account activation is an operator acceptance step: after checking prerequisites, remove `--dump-config` to start the web profile. First activation downloads the exact top-level packages; transitive dependencies are not locked. Use a reviewed local installation and replace the executable configuration for controlled deployments. Remove the corresponding `--patch` and restart to disable an integration. Both overlays must retain their approval row; renaming a namespace requires changing its policy too.

<a id="safety-and-failures"></a>
## Safety and failures

The [approval plugin](approval.mjs) accepts only reviewed tool names, requests the existing logged approval capability, and checks the grant again immediately before dispatch. An unavailable approval channel, rejection, cancellation, changed arguments or a bypassing policy listener prevents dispatch. Other policy denials remain denials. Unrelated namespaces are unaffected. Operators with configuration or shell access can change these protections; this is not an operating-system sandbox.

Personal tools can move focus and disclose private conversations. Official Account tools can read local files, fetch URLs, upload embedded images and modify themes. Approval is not filesystem or network confinement: review all paths, URLs, recipients and article content. Upstream tools sometimes encode failures inside successful MCP responses; inspect the returned details and the actual chat or draft before claiming success. A timeout after a write has an unknown outcome: check WeChat before retrying. Automatic reconnect is disabled, and neither overlay adds automatic call retries.

If npm reports `EACCES` for its cache, set `npm_config_cache` in the launcher environment to a dedicated writable directory. This development host has root-owned entries in its default npm cache; that is a local installation failure, not an Official Account authentication failure. Do not repair unrelated home-directory permissions recursively.

<a id="verification"></a>
## Verification

[Keyless tests](../../../tests/wechat-mcp.spec.ts) cover real Loader/MCP discovery with a protocol fixture and approval enforcement without touching an account. The fixture is not proof of either upstream server's account operations. Real-account reads, approved sends, media uploads, draft visibility, installed-desktop packaging and a recorded full agent-session scenario require separate acceptance. The [decision record](../../../../../.agents/notes/implemented/feature/2026-09-15-wechat-mcp-approval.md) explains the security choices.

## Dev Note

Verification evidence, not release acceptance: the live Wenyan discovery attempt on 2026-09-15 did not reach `tools/list`: the default cache failed with `EACCES`, and the isolated-cache attempt ended with an npm lock/cleanup error. Installation also warned about deprecated `@xmldom/xmldom@0.9.10`; this is an unresolved dependency-review item, not proof of an exploited vulnerability. Neither upstream server has live-account acceptance here. Do not promote these opt-in source examples to a production release on the strength of fixture tests.
