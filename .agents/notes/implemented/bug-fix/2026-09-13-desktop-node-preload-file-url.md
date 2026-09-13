# Agent Note: File URLs for desktop Node preloads

Status: implemented

English | [中文](2026-09-13-desktop-node-preload-file-url.zh.md)

## Problem

Node interprets the native Windows drive prefix in `--import C:\...` as an unsupported URL scheme. Unescaped `#` and `%` also change module resolution. The desktop preload runs before the normal Web profile, so this failure prevents installed Windows applications from reaching Host startup.

## Decision

The native supervisor converts its absolute preload path with the existing `url::Url::from_file_path` API and passes the serialized file URL to Node. Conversion failure reports the preload path before spawning the Host; no raw-path fallback runs. The profile-provisioning and installed-Host tests use Node's `pathToFileURL` for the same argument.

This conversion belongs to the process launcher. It does not change profile data, the supported `dsh web` entry, or [patch-plugin URL resolution](2026-09-05-patch-plugin-file-urls.md), which owns paths inside Cordis patches. WSL passes a Linux path to Linux Node and retains its existing launch arguments.

## Alternatives considered

**Convert only test arguments.** The production supervisor passes the same native path and would still fail on Windows after the tests passed.

**Prefix the path with `file://` manually.** Drive letters, separators and URL delimiters require platform-aware encoding already supplied by the URL libraries.

## Consequences

Rust tests require native-path round trips, URL-delimiter encoding and explicit rejection of a relative harness directory. The provisioning test executes the preload from a temporary directory containing spaces, Chinese characters, `#` and `%`; the installed-Host smoke exercises the normal authenticated Web profile and restart. Windows execution remains part of the release matrix, and a local macOS pass does not replace it.
