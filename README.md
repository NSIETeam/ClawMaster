---
description: ClawMaster WatchDog desktop downloads, first use, and development with the DSH runtime.
---
# ClawMaster

English | [中文](README.zh.md)

![ClawMaster](apps/desktop-tauri/app-icon.png)

## Summary

**开启AI时代的企业协作**

ClawMaster gives WatchDog a Tauri desktop workspace for delegating tasks, reviewing approvals, and opening results beside the conversation. DSH supplies the model, Session, tool, approval, and plugin infrastructure.

## Current status (kernel codename **Dawn**)

> **Agents must read this first:** [docs/STATUS-2026-09-21.md](docs/STATUS-2026-09-21.md) and
> [docs/DEFECTS-DAWN.md](docs/DEFECTS-DAWN.md), then `git log --oneline -20`, before doing any work in this repository.

- Baseline: desktop 0.0.1beta (reset 2026-09-21) · dsh 0.1.5-rc.2 (harness `72da6c767414dd30`) · 93/93 sessions healthy
- Skill auto-invocation verified (10/10 enterprise-plugin probes); 106 skills live
- Self-heal: `session-doctor` runs every 30 minutes (launchd `com.clawmaster.session-repair`)
- Known defects and mitigations: D1–D12 in [DEFECTS-DAWN](docs/DEFECTS-DAWN.md)

## Table of Contents

- [Downloads](#downloads)
- [First use](#first-use)
- [Components](#components)
- [Development](#development)
- [Licenses and upstream](#licenses-and-upstream)

## Downloads

Use the assets attached to a version in [GitHub Releases](https://github.com/NSIETeam/ClawMaster/releases). Each release includes `SHA256SUMS.txt`; build results and release notes state the platform evidence and signing status.

| System | Architecture | Package |
| --- | --- | --- |
| macOS 11.0+ | Apple Silicon / Intel | DMG |
| Windows | x64 | NSIS EXE |
| Linux | x64 | AppImage / deb |

First launch reuses compatible Node.js and pnpm installations or downloads them, then installs production dependencies; network access is required. Keep the existing DSH home to reuse model credentials, Sessions, and installed plugin configuration.

<a id="run"></a>
## First use

1. Open ClawMaster and follow the WatchDog tutorial. You can skip it and reopen it from Settings.
2. Open model settings and configure your provider. Existing credentials stay available; completing the tutorial does not test a model connection.
3. Describe the result you want in WatchDog. Creating a task allocates its working directory; simply opening the app does not create a default Workspace.
4. Review approvals and open the resulting files beside the conversation. Save edits before closing tabs or quitting.
5. Optionally connect a collaboration channel in Settings. A QR code starts setup; the channel is connected only after the platform confirms it.

## Components

The editor and browser open in the right panel; the terminal opens below the conversation. The [Office component](frontends/office/README.md) edits and saves basic DOCX, XLSX, and PPTX files locally, with conflict protection and preserved ONLYOFFICE notices and source access. CRM and ERP controls live in the component settings and open their own right-side tabs. CSV/TSV processing is exposed to AI tools without a separate data-processing page.

The desktop includes Agent Teams, OpenViking Memory, Routing Suite, Better Sidebar, and IM integration. OpenViking requires a separately configured memory service. The [desktop reference](apps/desktop-tauri/README.md) owns plugin versions and limitations; the [product frontend](frontends/dsh/README.md) owns task and business-component behavior.

<a id="run-from-source"></a>
## Development

Start with the [architecture](docs/architecture.md), [development guide](docs/development.md), and [Tauri build instructions](apps/desktop-tauri/README.md#build). Application launches use the existing `dsh` profiles. Public package names, plugin interfaces, Session formats, and credential storage retain their DSH identities.

## Licenses and upstream

ClawMaster builds on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the [Tauri desktop distribution](https://github.com/Sakana-yuyu/deepseek-harness-desktop). Their authorship and license notices remain intact. See the root [LICENSE](LICENSE), individual package licenses, and the Office component’s [license](frontends/office/LICENSE) for the applicable terms.

## Dev Note

None.
