---
description: "Use the ClawMaster update access ZIP to inspect an existing desktop, approve its first updater installation, and recognize when a native upgrade is required."
---

# ClawMaster update access kit

English | [中文](README.zh.md)

## Summary

This ZIP connects a compatible ClawMaster desktop to the update channel. It contains a read-only inspection utility and a signed updater component that can be installed locally. ClawMaster first checks the actual runtime and shows what it would change. You confirm that plan before installation. Complete desktop and DSH core upgrades use the native installation path.

## Table of Contents

- [Use the kit](#use-the-kit)
- [Understand the result](#understand-the-result)
- [Compatibility](#compatibility)
- [Data and recovery](#data-and-recovery)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

<a id="use-the-kit"></a>
## Use the kit

Compare the ZIP's SHA-256 digest with the [official download index](https://8.140.52.117/updates/clawmaster/kits/0.1.0/delivery.json) before running its contents. Start your existing ClawMaster desktop and extract the ZIP into a separate folder. Give ClawMaster the [execution guide](guide/README.md) and the extracted folder's location. Ask it to inspect this installation and show you the plan. Keep the files together so the utility can find the signed catalog, component archive and required verification files.

The entry file is `update-kit.mjs`; its default operation is read-only `inspect`. It requires Node `^22.19 || >=24`. ClawMaster locates the installed Node executable through the launch record, then runs the utility. Inspect the selected DSH home, runtime location, component version and planned profile edit. Confirm installation only for that plan. ClawMaster then uses the plan's artifact digest and profile revision, backs up the relevant profile files and mounts the updater for the first time. If those facts change before installation, inspect again and review the new plan.

The signed files in the ZIP support offline first installation. Subsequent server checks and native update downloads require network access. A network error during a later check does not mean that the local component failed to install.

The kit also provides an offline repair operation for a staged updater change. After the desktop has exited its Host, run `update-kit.mjs repair --yes --dsh-home <DSH_HOME>` from the extracted kit. The utility authenticates the kit before invoking the finite maintenance helper, applies the approved selection or restores an interrupted switch, and reports the durable operation state. It never downloads a candidate, launches DSH, or restores business data. Without `--yes`, it refuses to modify the selected home; if the Host is still alive, it stops before changing the profile.

After mounting, ask ClawMaster to run `/updates` in the same Host. The command lists current runtime information and available update metadata. Seeing the updater command and tools in that Host establishes that the Loader loaded the plugin; an `activation-pending` installation receipt alone does not.

<a id="understand-the-result"></a>
## Understand the result

The kit selects a path from evidence on the receiving machine.

| Result | Next action |
|---|---|
| `supported-component-bootstrap` | Review the first-install plan, then explicitly confirm that exact plan. |
| `updater-already-present` | Use its existing update entry points; the kit does not replace it. |
| `needs-location` | Supply the actual installation or runtime location and inspect again. |
| `native-upgrade-required` | Use the native desktop upgrade path after saving your work. |
| `activation-pending` | Observe the Loader and `/updates` before reporting success. |

When native upgrading is required, `native` first queries an online plan. A separately confirmed invocation requires an existing DSH home and downloads the verified payload into a file with its proper installer suffix. macOS receives an `.app.tar.gz` application archive that needs separate native installation. The kit reports that remaining step and does not unload the current desktop, remove its data or restart the conversation to finish an update.

<a id="compatibility"></a>
## Compatibility

Source comparison covers eight published tags: `desktop-v0.2.0-beta.1` through `desktop-v0.2.0-beta.6`, `desktop-v0.2.0-release`, and `desktop-v0.2.1`. Their DSH core and command, tool and approval packages use `0.1.5-rc.2`, and their launch records provide a common location mechanism. This establishes a source compatibility basis, not installation-test results for every release and operating system.

The kit checks the receiving runtime and Cordis package rather than trusting a version label or remembered path. An unknown earlier release, missing runtime or incompatible installation receives a location or native-upgrade result. The kit does not force a plugin into an unverified runtime.

Kit version `0.1.0` identifies this access utility and its signed contents. It is not a native desktop release number. Temporary-environment acceptance and source compatibility checks do not establish that a Windows installer has been tested in Windows Sandbox.

<a id="data-and-recovery"></a>
## Data and recovery

Inspection reads runtime identity and the profile information needed to plan installation. It does not read separate credential files or collect business documents and notes. The backup covers `profiles/web/cordis.patch.yml`, `profiles/web/package.json` and `cordis.patch.yml` below the selected DSH home. It records absent files and stores existing content below `DSH_HOME/clawmaster-updates/kit-backups/`, creating directories with mode `0700` and files with mode `0600`. Profile content can include credentials written directly into configuration; keep backups local and private.

Keep the returned installation and backup receipts. The kit has no restore command. If installation or profile loading fails, retain the backup and review the current profile before any separate recovery, so later edits are not overwritten. A pre-existing updater is not replaced. Updates to the updater itself are staged; restarting alone does not apply them.

<a id="further-exploration"></a>
## Further Exploration

- [Execution guide for ClawMaster](guide/README.md): the ordered inspection, approval and verification procedure.
- [ClawMaster desktop releases](https://github.com/NSIETeam/ClawMaster-Desktop/releases): native installation packages and release information.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run the kit build from `frontends/updates` after preparing the package's build dependencies. The packer preserves the published updater `0.1.0` archive and signed catalog bytes. Set the payload directory, signing-key path and ignored output directory to absolute paths; supply the source commit as 40 lowercase hexadecimal digits. Keep the private signing key on the signing machine.

```sh
node scripts/build-kit.mjs
node scripts/build-kit.mjs --check
node scripts/pack-kit.mjs --published-payload-dir "$KIT_PUBLISHED_PAYLOAD_DIR" --signing-key "$KIT_SIGNING_KEY_PATH" --source-commit "$KIT_SOURCE_COMMIT" --output-dir "$KIT_OUTPUT_DIR"
```

The output includes the ZIP, `SHA256SUMS.txt`, and `delivery.json` with its detached Ed25519 signature `delivery.json.sig`. The signed delivery fields bind the kit version, source commit, filename, versioned download URL, SHA-256 and byte count. Verify this index using the [independently pinned public key](https://github.com/NSIETeam/ClawMaster-Desktop/blob/b9b14f1ef05bbc9914658a1a672d820f793e92f8/frontends/updates/component-signing.pub) and compare the ZIP bytes before executing extracted code; the internal signed manifest then covers every packaged file.

Copy only the publication files to a private server inbox. On the publication server, use absolute paths and hold the publication lock for the whole command. The publisher verifies the signed delivery index and ZIP before atomically exposing the complete immutable version directory; it needs only the public key.

```sh
flock "$KIT_PUBLICATION_LOCK" node "$KIT_PUBLISHER_PATH" --inbox "$KIT_PRIVATE_INBOX" --root /var/lib/clawmaster-updates/kits --public-key "$KIT_PUBLIC_KEY_PATH"
```

`KIT_PUBLISHER_PATH` selects `frontends/updates/scripts/publish-kit.mjs` on the server. The download route `/updates/clawmaster/kits/` serves the publication directory with GET-only immutable responses. A published `0.1.0` directory contains `clawmaster-update-kit-0.1.0.zip`, `delivery.json`, `delivery.json.sig` and `SHA256SUMS.txt` at the same versioned URL prefix.

</details>
