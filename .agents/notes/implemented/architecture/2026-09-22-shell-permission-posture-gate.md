# Agent Note: Pin the shell's CSP and native-command grants to a reviewed posture

Status: implemented

English | [中文](2026-09-22-shell-permission-posture-gate.zh.md)

## Problem

The frontend README states the desktop shell's content-security policy and native-command grants in prose: which directives close the shell to foreign content, and that only the `main` WebView receives window and restart commands while the Host content WebView receives none. Nothing failed when that configuration drifted. A new Tauri permission, a relaxed `script-src`, or a second WebView added to the capability file would ship silently, and a reviewer would have to notice the divergence by reading two JSON files against a paragraph.

## Decision

`apps/desktop-tauri/scripts/shell-permission-posture.mjs` audits the shipped shell configuration against a reviewed posture and returns a finding for every divergence: `CLOSED_CSP_DIRECTIVES` (each must stay `'none'`), `SELF_ONLY_CSP_DIRECTIVES` (each must allow `'self'` and admit no `'unsafe-inline'`, `'unsafe-eval'`, or `*`), `REVIEWED_WEBVIEWS`, and `REVIEWED_PERMISSIONS`.

The posture is the source of truth for what needs justification, not a copy of the configuration: adding a native command or widening a directive fails the audit until the same change extends these lists and the README sentence they back. `auditShellPosture` reads `tauri.conf.json` and every `capabilities/*.json`, so a grant placed in a new capability file is audited too.

`apps/desktop-tauri/scripts/shell-permission-posture.test.mjs` runs the audit against the shipped configuration and against perturbed copies: a null or wildcard policy, inline-and-eval allowances, an unreviewed permission, a second WebView, and each closed directive dropped one at a time. Every invalid case is rejected, so the gate cannot pass by becoming permissive.

## Consequences

The audit covers configuration, not enforcement. It proves what the shell is permitted to reach and that no WebView outside the reviewed set receives native commands; it does not prove a WebView behaves correctly, and it does not constrain the Node Host, the native process tree, or any plugin running with the user's privileges. Those limits stay where the frontend README's execution-authority table records them, and this audit does not restate that table.

Reading the configuration rather than the built application means a packaging step that rewrites `tauri.conf.json` would move the audited file away from the shipped one. The desktop build consumes this configuration as its source, so the two coincide today.
