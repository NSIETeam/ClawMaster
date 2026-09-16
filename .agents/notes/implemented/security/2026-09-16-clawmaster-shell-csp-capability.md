# Agent Note: ClawMaster shell CSP and capability scope

Status: implemented

English | [中文](2026-09-16-clawmaster-shell-csp-capability.zh.md)

## Problem

The packaged shell capability covered the splash and main window labels, while the content WebView relied on label exclusion alone. The shell CSP also allowed inline styles even though all shell behavior and presentation were static local assets.

## Decision

Grant the three native window commands only to the `main` shell WebView. Keep the splash and Host content outside every capability entry. Move shell and splash behavior and styles to local files, then use a CSP with same-origin scripts and styles and no inline exception.

## Consequences

The Host content cannot invoke desktop commands through a matching capability, and the splash cannot receive shell controls. The packaged shell remains functional through local assets while its CSP has no `unsafe-inline` or `unsafe-eval` allowance. This protects the Tauri shell surface; it does not isolate trusted in-process DSH plugins from one another.
