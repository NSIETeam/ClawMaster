# Agent Note: ClawMaster shell CSP and capability scope

Status: implemented

English | [中文](2026-09-16-clawmaster-shell-csp-capability.zh.md)

## Problem

The packaged shell capability covered the splash and main window labels, while the content WebView relied on label exclusion alone. The shell CSP also allowed inline styles even though all shell behavior and presentation were static local assets.

## Decision

Grant the three native window commands only to the `main` shell WebView. Keep the splash and Host content outside every capability entry. Move shell and splash behavior and styles to local files, then use a CSP with same-origin scripts and styles and no inline exception.

The Host page is served from the DSH frontend distribution and carries its own response CSP because Tauri's packaged-page CSP does not set headers on this external loopback page. Its policy hashes exact boot-time inline script and style blocks, gives trusted runtime scripts and styles separate per-response nonces, allows same-origin script files and requests, permits only local preview frames and workers, and blocks inline event handlers and native objects. The style-attribute exception remains limited to layout values rendered by the DSH UI.

Dynamic Cordis browser code comes from the owning Session's authorized active run through `getClientCode`. The evaluator uses its script nonce to compile that source into a closure, removes the temporary script and callback, then executes the closure. No `unsafe-eval` permission or general-purpose global evaluator is exposed; HTML-looking source text remains script text. The nonce is available to trusted page code and is not an isolation mechanism between approved plugins.

## Consequences

The Host content cannot invoke desktop commands through a matching capability, and the splash cannot receive shell controls. The packaged shell remains functional through local assets while its CSP has no `unsafe-inline` or `unsafe-eval` allowance. The separately served Host document rejects unlisted inline scripts even when it includes DSH boot code. These policies protect the WebViews from injected page content; they do not isolate trusted in-process DSH plugins from one another.

## Alternatives considered

**Rely on the Tauri shell CSP.** This leaves the DSH Host page without a response policy because the runtime serves it over loopback.

**Allow every inline script.** This admits scripts that were not part of the rendered Host document; hashing exact inline blocks keeps the boot code available while rejecting later additions.
