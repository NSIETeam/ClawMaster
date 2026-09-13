# Agent Note: Desktop shell chrome and overlay plugins

Status: implemented

English | [中文](2026-08-14-desktop-shell-overlay-plugins.zh.md)

## Problem

The desktop fork must add window chrome, a tray, signed updates, and task-complete alerts without editing upstream Harness packages. Later syncs should pull `packages/`, `apps/cli`, and `apps/web` unchanged. Features that must observe Host session events cannot live only in the WebView, because that would require changing the shipped web client.

## Decision

The upstream terminal emulator owns cursor-query replies and their asynchronous completion. The desktop fork removes its fixed-position reply so each query receives one response and readiness waits for that response.

**The content uses its own native WebView.** A cross-site iframe cannot retain the Host's `SameSite=Strict` login cookie. The supervisor accepts only the expected loopback origin and a single non-empty token from the child stdout, verifies the cookie-exchange redirect without following it, and passes that address to the content WebView without logging it. The local chrome keeps its own WebView and permissions; the remote content receives no native window permissions. The close dialog temporarily hides content so it cannot cover the dialog. Both native and WSL commands place launcher patches before `--no-open` and other Web arguments. Tauri's `unstable` feature enables its existing multi-WebView API; platform packaging and a real window startup remain required evidence.

**Native window controls stay in `apps/desktop-tauri`.** The main window uses system decorations; macOS hides title text and reserves traffic-light space. The splash uses the ClawMaster mark and system appearance. The local `shell.html` owns the first-close choice and persists it in the platform application-data `DeepSeek Harness/desktop-settings.json`. Closing follows the saved preference; the tray can change it, show the window, restart or quit. Hide keeps the Host running. Quit, restart and update installation stop the owned Host tree before exiting. Windows uses a `KILL_ON_JOB_CLOSE` Job for descendants. Reopening the macOS application shows an existing hidden window. The system owns window appearance; the embedded client owns its selected Web theme.

**Host collaboration is an overlay plugin, not a package edit.** The shell copies `overlay/desktop-notify/index.mjs` into `$DSH_HOME/desktop-overlay`, writes a `--patch` list whose plugin `name` is a `file://` URL, and starts `dsh web --patch <that file>`. A Windows drive path such as `C:/...` is not a valid ESM specifier — Node reads `C:` as a URL scheme — so the overlay must emit `file:///C:/...` (spaces percent-encoded). The plugin listens for `session/event` `turn/end` with `reason.kind === 'completed'` and POSTs to a loopback notify URL supplied as `DSH_DESKTOP_NOTIFY_URL`. The Rust listener shows a system toast and plays `sounds/complete.wav` only when the main window is unfocused.

**Updates use the signed Tauri updater.** The [stable update decision](2026-09-13-desktop-stable-confirmed-updates.md) owns channel selection and separate download/install confirmations. Startup checks after the main window opens and only announces availability; network failure does not hold the splash.

This extends [cross-platform desktop source provisioning](../feature/2026-08-14-cross-platform-desktop-source-provisioning.md) without moving desktop behavior into `packages/`.

## Alternatives considered

**Patch `apps/web` or a `packages/*` plugin.** Rejected because every upstream sync would re-apply or lose the desktop behavior. The overlay uses the documented `--patch` layer instead.

**Write `$DSH_HOME/cordis.patch.yml` directly.** Rejected because that file is the user's home-level patch layer. A generated `--patch` file leaves the home file for the user.

**Inject a title bar into the React DOM.** Rejected because it couples chrome to web client markup and still cannot own tray, update, or OS notifications.

**Always quit on the title-bar close button.** Rejected because a coding session should survive an accidental close; the first close asks, then the saved preference and the tray own process lifetime.

**Always hide on close with no prompt.** Rejected because some users want close to exit, and a missing tray made hide look like a crash.

## Consequences

Upstream framework trees stay free of desktop-only rows. A missing overlay file fails Host startup loud. Users who already have a home `cordis.patch.yml` keep it. Focused-window turns do not toast or chime. Screenshot assets in `apps/desktop-tauri/screenshots/` are illustrative of the shell, not recorded from a live session.
