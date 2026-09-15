---
description: "Check signed ClawMaster component releases, approve component activation, and prepare verified desktop update files in an existing DSH profile."
kind: "package-reference"
---

# ClawMaster Updates

English | [中文](README.zh.md)

## Summary

ClawMaster can check a server for signed component releases without replacing its desktop application. You can approve a selected update and activate eligible components in an existing DSH web profile. Background checks only read update information. Updates to the updater itself require a stopped-Host installation; native application and DSH core updates still require a desktop installer.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This plugin mounts into an existing DSH web profile. It does not declare a `dsh.bundle.patch`; installing it as a package dependency does not activate it. The finite [first-install utility](src/install.ts) selects one DSH home and runtime root, verifies the component catalog, and shows a plan before it can change that profile.

An operator uses `install.mjs` from the verified updater distribution with `--dsh-home` and `--runtime-root`. Without `--yes`, the utility reads runtime information and the signed catalog, then returns the selected version, digest, size and profile revision without downloading the component or changing files. To confirm that plan, add `--yes --expected-sha256 <plan.sha256> --expected-patch-revision <plan.expectedPatchRevision>`. A changed candidate digest or profile revision rejects installation before writing files. The utility refuses to replace an existing updater row or declared updater dependency.

The confirmed installation adds an updater-owned row to the selected profile's `cordis.patch.yml`. A running Host that watches that profile can load the row without restarting the desktop. The result is `activation-pending`, not proof that loading succeeded: check that `/updates` is available in that Host before treating installation as complete. The utility neither starts another DSH application nor changes the native updater endpoint compiled into an installed `0.2.1` desktop.

Use `/updates` or ask the agent to use `clawmaster_updates` to inspect current update information. Neither entry point downloads an artifact or changes files. To prepare a selected update, the agent uses `clawmaster_update` with its kind and version, plus a component id when applicable. One approval covers the concrete operation shown: a hot component is downloaded, verified, installed and submitted to the Loader; a restart-only component is downloaded, verified and staged. The selected bytes and profile revision are pinned before approval.

For an eligible hot component, activation changes only its updater-owned profile row and returns a rollback token. Loader observation establishes whether the component actually loaded. A changed profile revision rejects activation or a maintainer's rollback rather than replacing intervening edits. A component marked `restart`, including `updates` itself, is staged without editing the watched profile: restarting the app alone does not apply that staged change.

-----

<a id="configuration"></a>
## Configuration

The [configuration schema](src/config.ts) owns the accepted fields and defaults. The [first-install utility](src/installer.ts) pins the production component endpoint and public key. Runtime compatibility uses the selected Host's DSH version; a signed archive must also contain its declared dependencies and match the shared Host package versions.

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `DSH_HOME`, otherwise `~/.dsh` | Existing selected Host home; update requests cannot override it. |
| `catalogUrl` | `https://8.140.52.117/updates/clawmaster/components/catalog.json` | Signed component metadata. |
| `nativeManifestUrl` | `https://8.140.52.117/updates/clawmaster/latest.json` | Native desktop release metadata. |
| `publicKeyPem`, `nativePublicKey` | Shipped component and Tauri public keys | Independent trust anchors for the two kinds of artifact. |
| `checkIntervalMs` | `60000` | Automatic metadata check interval; `0` disables automatic checks. |
| `nativeTarget` | Observed platform and installation type | Explicit selection is required when the Host cannot establish the installer type. |
| `locale` | `zh-CN` | Command and approval language; also accepts `en-US`. |

Polling reads metadata only. Network failures appear as unavailable channel information, and the other channel can still be checked. Plugin disposal cancels and waits for its checks and update operations. Request, download and archive limits are configurable in the same schema; profile patches have a fixed 2 MiB safety limit.

Updater-owned files live below `DSH_HOME/clawmaster-updates/`. Version directories are immutable; download digests identify cached bytes. The profile edit is confined to `DSH_HOME/profiles/web/cordis.patch.yml`. Existing sessions, credentials and unrelated profile rows are not update targets.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [catalog reader](src/catalog.ts) verifies a detached Ed25519 signature over the exact catalog bytes before accepting their schema. It pins the public key, requires HTTPS, rejects redirects and restricts component artifact URLs to the configured origin and component artifact path. The signed descriptor identifies each version, compatible DSH version, activation mode, byte count and SHA-256 digest. The [download helper](src/download.ts) enforces request and byte limits before publishing verified cached files.

The [component installer](src/components.ts) validates the archive before extraction, accepts regular package files and directories, and rejects unsafe paths, links, duplicate paths and incomplete dependency closures. It does not run npm lifecycle scripts. Installation records file hashes; activation rechecks those hashes and uses a file lock plus the reviewed profile revision. Rollback restores the recorded prior profile only when the successor revision still matches.

The [bootstrap](src/bootstrap.ts) permits the updater's first mount while a Host runs; it cannot replace an updater that is already present. Ordinary updates to restart-only components remain operation records awaiting a separate stopped-Host installation. This prevents the updater from unloading itself during its own active operation. The exported `rollbackComponent` API is for confirmed maintainer recovery; it is not exposed by the command or agent tools.

The [native download helper](src/native.ts) verifies desktop payloads with the existing Tauri Minisign public key in an abortable worker. It returns `requires-native-installer` and never launches an installer. Serving a native manifest, downloading an authenticated file, and installing that file are separate outcomes.

Component publication uses the [build](scripts/build.mjs), [pack](scripts/pack.mjs), [offline signer](scripts/sign-catalog.mjs) and [server publisher](scripts/publish-catalog.mjs). The signer authenticates the catalog and separately signs the finite installer after comparing it with the archived installer. Installer signatures include a domain identifier and the versioned filename, preventing reuse under another version's name. The publisher needs only the pinned public key and a caller-held publication lock. It verifies inputs, refuses version rollback or changed immutable versions, and publishes complete files before switching the active catalog pointer. Private signing material stays off the distribution server.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DSH profiles](../../packages/boot/app-boot/README.md): profile composition and loading.
- [User approval](../../packages/interaction/user-approval/README.md): one-shot decisions for agent operations.
- [Server update publication](../../apps/desktop-tauri/server-updates/README.md): distribution and operational recovery.
- [Installed DSH update decision](../../.agents/notes/implemented/architecture/2026-09-15-installed-dsh-component-updates.md): ownership and rejected alternatives.
- [Desktop releases](../../apps/desktop-tauri/README.md#release): native installation and restart behavior.

-----

<a id="model-experience"></a>
## Model Experience

`clawmaster_updates` checks update metadata without write approval. `clawmaster_update` selects a component, runtime or native release; its arguments cannot supply an arbitrary URL, trust key, local path or profile row. Mutations require an owning agent Session and an `allowed-once` decision; rejection or cancellation does not authorize a write. Results distinguish pending Loader activation, staged restart-only changes, runtime files requiring desktop support and files requiring native installation. The model must report those states accurately rather than describe a staged or downloaded update as active.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Available operations depend on the catalog and the selected Host.

- The initial component catalog contains only `updates` version `0.1.0`; it does not establish that a new DSH runtime or other component is available.
- No separate update page or sidebar is provided. The existing command and agent tool are the user entry points.
- Restart-only changes are staged. This package has no automatic apply-on-restart or stopped-Host replacement command.
- DSH core and native application files cannot be hot-replaced. Verified native downloads still require the desktop installation path.
- Activation and rollback receipts describe profile edits. Loader health and compatibility in a real installed desktop require separate observation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
