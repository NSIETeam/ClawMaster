---
description: "Instructions for ClawMaster to inspect and first-mount the signed update component from an extracted ZIP while preserving the current desktop and user data."
---

# Give this guide to ClawMaster

English | [中文](README.zh.md)

## Summary

Inspect the current ClawMaster installation using this kit, show the user the concrete plan, and install the updater only after the user confirms that plan. Verify actual loading before reporting success. Preserve the current conversation and user data throughout.

## Table of Contents

- [Inspect first](#inspect-first)
- [Confirm and install](#confirm-and-install)
- [Verify the outcome](#verify-the-outcome)
- [Handle an incompatible installation](#handle-an-incompatible-installation)
- [Dev Note](#dev-note)

<a id="inspect-first"></a>
## Inspect first

1. Read the [kit overview](../README.md), verify the ZIP digest against the official download index, and locate the extracted kit directory. Resolve the installed Node executable from the `node` field in `dsh-launch.json`; do not assume that the system PATH selects the same runtime. The kit does not start another agent application.
2. Run `update-kit.mjs inspect` with that Node executable from the extracted directory. The utility uses the current environment, working directory and known platform launch-record locations; `--dsh-home`, `--runtime-root` and `--launch-manifest` provide explicit locations. Use records as location hints, then verify the actual runtime and Cordis packages. A remembered directory or version is not proof of compatibility.
3. Read only runtime and profile information needed for this operation. Do not read separate credential files or collect business documents and notes. Do not print profile contents or credentials embedded in them. Keep the local profile backup private. Do not uninstall the desktop, delete its home, stop the Host or restart the conversation.
4. Show the selected home and runtime, the updater version, its authenticated digest, the reviewed profile revision, the proposed changes and the backup scope. If the result requires a location, request that location before attempting installation. If it requires a native upgrade, follow the native path below.

<a id="confirm-and-install"></a>
## Confirm and install

1. Obtain the user's explicit confirmation of the displayed plan. Inspection by itself does not authorize installation. Retain `inspect.component.sha256` and `inspect.patchRevision`, plus any explicit location arguments used for inspection.
2. Run `update-kit.mjs install --yes --expected-sha256 <inspect.component.sha256> --expected-patch-revision <inspect.patchRevision>` with the same Node executable and locations. Substitute the values actually returned by inspection. Let the tool validate the signed local files, retain its three-file profile backup under `DSH_HOME/clawmaster-updates/kit-backups/`, and mount only the updater's first row. A changed digest or revision requires a new inspection and a new reviewed plan.

3. If an installed updater has already produced a staged operation but the receiving desktop does not include its maintenance helper, exit the Host and run `update-kit.mjs repair --yes --dsh-home <DSH_HOME>` from this kit. The command authenticates the kit, applies or recovers only the approved updater operation, and prints its durable state. It refuses to run while the recorded Host is alive and does not touch business data.
3. If an updater is already present, use its existing command and tools. Do not bypass that check, remove its row or replace its version. A self-update is a separately staged operation and is not applied by restarting alone.
4. Retain the installation result and backup location. The kit has no restore command; recovery requires a separate review of the current profile and retained backup. A failure is not permission to overwrite a profile or restore an old backup over later edits.

<a id="verify-the-outcome"></a>
## Verify the outcome

Observe the same Host after installation. Confirm that `/updates`, `clawmaster_updates` and `clawmaster_update` are registered, then execute a read-only update check. Distinguish Loader activation from server availability: offline checks can report unavailable channels while the local plugin is loaded.

Report the installed component version, the observed command or tool evidence and any remaining step. Do not describe `activation-pending`, a verified download, or a staged restart-only update as an active desktop upgrade. If loading fails, preserve the error and profile revision for a reviewed recovery.

<a id="handle-an-incompatible-installation"></a>
## Handle an incompatible installation

For an unknown or incompatible runtime, report `native-upgrade-required` or `needs-location` with the observed reason. Do not manufacture a compatible version, modify DSH core packages, or force the updater into that runtime.

Run `update-kit.mjs native` with the resolved Node executable to obtain an online preparation plan. On Linux, explicitly supply `--native-target linux-x86_64` for AppImage or `--native-target linux-x86_64-deb` for DEB; verify which format is installed before choosing. After the user confirms the displayed plan, run `update-kit.mjs native --yes --expected-native-version <plan.version> --expected-native-digest <plan.digest>` with the same location and target arguments. The confirmed download requires an existing DSH home. It verifies the native payload and returns a file with its installer suffix without starting an installer; macOS returns an `.app.tar.gz` application archive requiring separate installation.

Report the resulting file and that native installation remains required. Ask the user to save work and complete the native installation separately; do not launch it or restart the conversation from this procedure.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
