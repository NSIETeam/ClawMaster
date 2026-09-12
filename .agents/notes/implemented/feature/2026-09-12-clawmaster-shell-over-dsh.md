# Agent Note: ClawMaster shell over DSH

Status: implemented

English | [中文](2026-09-12-clawmaster-shell-over-dsh.zh.md)

## Problem

ClawMaster needs the mature DSH runtime, session, approval, tool, and plugin ecosystem without maintaining a second agent backend. The product still needs a Tauri desktop shell, ClawMaster visual identity, and enterprise IM onboarding through QR codes. Shipping the upstream desktop unchanged exposed the DeepSeek Harness name in the splash, window chrome, notifications, and Web UI.

## Decision

ClawMaster owns the product presentation and Tauri shell. DSH owns runtime execution, sessions, tools, approvals, storage, and plugin loading. The `@clawmaster/dsh-frontend` package is installed as an external DSH Web profile plugin through public client slots; it adds the ClawMaster icon, WatchDog navigation and workbench, and the slogan “开启AI时代的企业协作”. Its Host creates a system-owned Workspace under `$DSH_HOME/watchdog-workspaces/managed`, and every new WatchDog session explicitly binds to that Workspace instead of inheriting the user's current or recent Workspace. The same bundle enables the official DSH Schedule and time-context rows; DSH base already provides Goal and goal-round-driver. The `@xmanrui/dsh-im` plugin supplies Feishu, Weixin, WeCom, and DingTalk QR onboarding through the same DSH profile.

The default profile also mounts `dsh-better-sidebar@0.19.1`, which is verified by its maintainers against DSH 0.1.5-rc.2 and supplies the native right sidebar, CodeMirror editor, file previews, sandboxed multi-tab browser, terminal, Git, and task views. ClawMaster adds small local-first data, CRM, and ERP components for direct use in the WatchDog workbench. The CRM and ERP records use browser local storage in this version; they are usable desktop modules, not a multi-user enterprise database.

All user-visible native strings and assets use ClawMaster: application metadata, splash, browser document title, tray, notifications, close dialog, Windows shortcut, and installer icon. The custom window title bar keeps only the drag region and window controls, without a duplicate product mark or name. Internal `dsh` commands, package names, profile data, and legacy application-data paths remain compatibility contracts.

DSH exposes a mark slot but no hero-headline slot. The ClawMaster mark therefore scopes a `MutationObserver` to `[data-phase="hero"]` and replaces only the exact upstream Chinese or English headline. This keeps the customization outside DSH source, at the cost of a visible UI regression check after an upstream text or markup change.

## Alternatives considered

**Keep the previous ClawMaster runtime.** This would preserve full ownership but duplicate DSH session, tool, approval, and plugin work, which conflicts with the maintenance goal.

**Ship the upstream DSH desktop without branding.** This would minimize code, but the application would identify itself as DeepSeek Harness during launch and normal use.

**Fork the DSH Web client.** This could replace every string directly, but it would create a second Web UI and turn upstream upgrades into recurring merge work.

## Consequences

DSH plugin compatibility follows the live DSH profile because ClawMaster does not proxy or reimplement the plugin protocol. Compatibility still depends on each plugin's declared DSH version and must be validated at runtime. The audited community `dsh-stall-guard@1.3.0` is not a default: it uses an obsolete `agent/status` listener shape and appends `user/message` without the surface intent required by DSH 0.1.5-rc.2. `dsh-univer-office@0.2.14` is also excluded because it declares only DSH 0.1.1-rc.2 or 0.1.2-rc.1 peers, not the current 0.1.5-rc.2 runtime. Official Goal and Schedule provide the accepted continuation and timed-follow-up baseline. Enterprise IM credentials remain in the plugin and DSH home; ClawMaster does not copy them into ordinary configuration. The four platform connections are only accepted after their QR codes are rendered and an operator completes each scan. Desktop releases must verify the splash, title bar, Web hero, settings, and notifications for residual upstream branding.
