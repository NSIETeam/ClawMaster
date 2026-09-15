# Agent Note: Component updates in an installed DSH profile

Status: implemented

English | [中文](2026-09-15-installed-dsh-component-updates.zh.md)

## Problem

An installed desktop's native update endpoint is compiled into its binary. Changing a server manifest or DSH profile cannot change that endpoint. Requiring a complete desktop replacement for every independent component also couples component delivery to native packaging. A live updater must distinguish adding its first instance from replacing itself, and must preserve user edits while coordinating profile reloads.

## Decision

The [DSH update plugin](../../../../frontends/updates/README.md) mounts into the existing web profile and uses DSH commands, tools and one-shot user approval. Its finite first-install utility reads an explicitly selected DSH home and runtime root. The default operation displays a plan without changing files; explicit confirmation bound to the plan's digest and profile revision installs authenticated component bytes and adds only the updater's first profile row. Existing updater rows or declared updater dependencies reject this bootstrap. The utility is not an application launcher, and the package does not declare a `dsh.bundle.patch`.

The [update access kit](../../../../frontends/updates/kit/README.md) carries signed local component files for offline first mounting. Its inspection uses `dsh-launch.json` and desktop records to locate an installation, then checks the actual runtime packages. Records locate files; they do not establish compatibility. Confirmed installation binds the selected digest and profile revision and backs up the three related profile configuration files without reading separate credential files or collecting business data. Backup files use mode `0600`; configuration can contain embedded credentials and is retained privately. Missing locations and incompatible runtimes produce explicit results instead of forced activation.

A component catalog uses a pinned Ed25519 public key independent of the native Tauri key. Its signature authenticates exact catalog bytes, including each immutable artifact's version, digest, size, DSH compatibility and activation mode. Component artifacts are self-contained; installation validates archive paths, dependencies and file hashes without running package-manager lifecycle scripts. The distribution server cannot change those signed facts without the component signing key.

Read-only discovery is separate from update preparation. One approval binds an update operation to authenticated candidate metadata, the running Host and the reviewed profile revision. Hot activation edits only updater-owned rows in the watched web profile patch and returns a pending Loader state plus a rollback token. The Loader, not a successful file write, establishes that the new plugin is active. Confirmed maintainer rollback requires the successor revision to remain current, preserving intervening user edits; the rollback API is not exposed through the command or tools.

The updater itself and other restart-only components are staged without replacing watched rows. The first updater mount is the sole live bootstrap exception because it replaces no loaded updater. Restarting the app alone does not apply staged changes; replacement requires a separate stopped-Host installation. DSH core and native application files remain outside hot activation. Native payload preparation retains Tauri Minisign verification and returns a requirement for native installation without launching it.

The [native stable-update decision](2026-09-13-desktop-stable-confirmed-updates.md) continues to own native version selection, scheduling and installation consent. The [self-hosted publication decision](2026-09-15-desktop-self-hosted-update-channel.md) continues to own mirroring and atomic publication of native release files. This plugin adds an independent component consumer without changing either decision or the endpoint in already installed `0.2.1` binaries. The package README owns user operations and limitations; the [server reference](../../../../apps/desktop-tauri/server-updates/README.md) owns publication procedures.

## Alternatives considered

**Replace the desktop to introduce every component.** Native packaging remains necessary for native application and core changes. Independent components can use the existing DSH profile loader, avoiding an unnecessary desktop replacement for their first installation or eligible hot updates.

**Treat package installation as activation.** A package without a bundle patch does not contribute a profile layer through `dsh plugin add`. An explicit first-mount utility verifies bytes and records the actual row that the Loader watches.

**Assume every older desktop accepts the same plugin.** Shared source versions provide a compatibility basis, but an installed runtime may differ or be incomplete. Inspection verifies the receiving installation; unknown or incompatible installations require location information or native upgrading.

**Replace the updater while its own tool is executing.** Reload can dispose the operation that is performing the replacement. Staging self-updates without modifying the watched patch preserves ownership until an external stopped-Host installation.

**Trust HTTPS and package names alone.** A distribution error or server compromise can serve different bytes under the same name. A pinned catalog key, authenticated digests and immutable component directories bind the approved operation to selected bytes.

**Report successful profile writes as completed updates.** Loader failures can follow a valid patch write. Pending states keep installation evidence separate from actual activation, and revision-bound rollback preserves unrelated changes.

## Consequences

Component updates can reuse a running DSH profile and existing approvals without adding another application process or a separate graphical update page. The component signing key creates a distinct publication responsibility. The initial catalog contains only the updater component; it does not imply that runtime or other component updates are available.

Staged restart-only updates need an external installation path; this plugin provides no automatic apply-on-restart. Native installer execution and real platform acceptance remain separate from verified downloads. Component validation, first-mount refusal, revision conflicts, rollback and approval denial require focused tests; a live Loader observation remains necessary before declaring a first installation active.

The kit's compatibility evidence distinguishes source comparison from installation acceptance. A source audit of published tags is not a claim that every old installer has run on every platform. Native fallback prepares an online verified download and leaves native installation to a separate user action, preserving the Host that owns the current conversation.
