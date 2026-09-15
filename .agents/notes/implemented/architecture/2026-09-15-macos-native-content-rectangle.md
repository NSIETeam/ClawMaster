# Agent Note: macOS controls outside the content WebView

Status: implemented

English | [中文](2026-09-15-macos-native-content-rectangle.zh.md)

## Problem

A full-size macOS content view lets native traffic lights overlap the first controls in a conversation, sidebar or plugin. Padding a header found by the ClawMaster mark cannot protect other plugin layouts or a remounted header. Native window geometry needs one owner independent of the embedded page.

## Decision

The [native shell](../../../../apps/desktop-tauri/src-tauri/src/chrome.rs) selects `TitleBarStyle::Transparent` and `hidden_title(true)`. In the locked Tauri runtime, this disables the full-size content view and retains the native title-bar area above the window's content rectangle. The child WebView fills that rectangle; the shell adds no artificial title-bar offset. Native controls and plugin content therefore occupy separate areas without identifying plugin DOM elements, observing their mounts or injecting overlay metrics.

macOS supplies the window background and title-bar appearance. The shell does not fix that area to a dark color. The embedded client retains its separately selected Web theme. This decision replaces only the overlay reservation in the [native-window decision](../feature/2026-09-13-clawmaster-native-window-titlebar.md); that note continues to own native decorations, close handling and reopening the existing Host.

## Alternatives considered

**Keep overlay mode and reserve space in each plugin header.** That can preserve a compact title area, but depends on every plugin's markup, mount lifecycle and topmost controls. A sidebar-only reservation leaves other surfaces exposed.

**Select `TitleBarStyle::Visible`.** The locked `tauri-runtime-wry` 2.11.4 enables a full-size content view for both `Visible` and `Overlay`. The option name does not establish that the native controls are outside the WebView.

## Consequences

The native title bar uses vertical space and may differ from a user-selected Web theme. This cost avoids per-plugin layout adaptations and lets the platform own window controls, dragging, sizing and appearance.

Packaged macOS release acceptance requires measured screen-coordinate rectangles for the native traffic lights and the content WebView, with no overlap. Missing or ambiguous geometry cannot establish success. Source flags, DOM strings and synthetic layout fixtures alone do not prove the installed window's geometry. The [native acceptance script](../../../../apps/desktop-tauri/scripts/verify-macos-native.mjs) owns the executable check; the [acceptance decision](../testing/2026-09-15-macos-native-relaunch-acceptance.md) retains its platform and lifecycle evidence limits.
