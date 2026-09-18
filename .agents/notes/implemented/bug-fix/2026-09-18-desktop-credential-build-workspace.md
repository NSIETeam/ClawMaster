# Agent Note: Install credential frontend build dependencies in the workspace

Status: implemented

English | [中文](2026-09-18-desktop-credential-build-workspace.zh.md)

## Problem

The desktop release build runs the credential frontend's artifact check. That script imports `esbuild`, but the frontend was outside the pnpm workspace, so a clean workspace install did not link its declared development dependencies. Release builds then failed before producing desktop bundles.

## Decision

Register `frontends/credentials-keychain` in both workspace manifests. A normal frozen workspace install now installs the build tool declared by the frontend package before the desktop artifact check runs.

## Alternatives considered

- **Assume another workspace package exposes `esbuild` transitively** — clean installs do not guarantee undeclared dependencies are available to this frontend's build script.

## Consequences

The frontend remains independently versioned and its runtime dependencies remain unchanged. Workspace lockfile updates must include the credential frontend importer and its development dependencies.
