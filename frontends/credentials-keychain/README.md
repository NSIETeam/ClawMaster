---
description: "Desktop profile layer that stores DSH model keys and plugin grants in the operating system credential store."
kind: "package-bundle"
---

# ClawMaster Secure Credentials

English | [中文](README.zh.md)

## Summary

The ClawMaster desktop profile resolves model keys and plugin grants through the macOS Keychain or Windows Credential Manager. The desktop host owns native storage; DSH stores only credential references in configuration. This private bundle replaces the base profile's file-backed credential provider. It is included in ClawMaster desktop and is not supported as a standalone bundle.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

ClawMaster installs this bundle in its desktop Web profile. Users manage keys through the product's model settings; the runtime sends credential operations over the private Tauri host pipe to the platform credential API. WSL mode uses the Windows desktop host's secure store; a standalone Linux desktop host is unsupported.

At first launch, the provider imports recognized entries from `$DSH_HOME/.credentials.yaml`, inherited secret environment variables, and the invocation and user `.env` files. WSL launches also pass the resolved Windows DSH-home paths as explicit migration roots, so an upgrade into WSL can import legacy Windows credentials through the same host broker without copying credential files into the Linux home. It reads each value back before removing the matching plaintext entry and preserves unrelated `.env` bytes. A failed native-store operation, malformed file, unsupported source, or conflicting existing value leaves source material in place and logs a warning without stopping application startup. Users can remove a preserved source after saving its keys through model settings.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [profile patch](cordis.patch.yml) replaces the `credentials` service row, so existing DSH consumers and the actual model provider continue to use the public `ctx.credentials` API. Secret values travel over a dedicated newline-delimited protocol on inherited Tauri pipes; only the Rust desktop host talks to Keychain or Credential Manager. The provider keeps a metadata-only record index under `$DSH_HOME` because native stores do not enumerate records.

The migration rejects linked and non-regular source files, uses an atomic native no-clobber write, and verifies every reference and record before source cleanup. Migration errors are contained during plugin initialization; later credential operations report the unavailable secure store at the feature that needs it.

</details>

<a id="further-exploration"></a>
## Further Exploration

The [desktop host](../../apps/desktop-tauri/src-tauri/src/native_broker.rs) owns OS APIs. The [credential provider API](../../packages/credentials/credentials/README.md) defines DSH consumers' reference and record operations.

<a id="model-experience"></a>
## Model Experience

Model adapters resolve each configured credential reference through `ctx.credentials` immediately before use. A key stored through the product settings is read from the OS secure store on every operation; values do not enter configuration, the record index, or provider logs.

## Known Limitations and Deferred Work

- OS-native credential operations require the ClawMaster desktop host and its inherited-pipe broker. A standalone DSH process cannot access this provider.
- Linux and other desktop shells do not have a supported secure-store broker in this package.
- A failed `.env` cleanup keeps the source file and reports that manual cleanup is needed; users should remove the migrated assignment after confirming the key appears in model settings.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Native macOS Keychain and Windows Credential Manager behavior must be verified in the built desktop host on their respective operating systems. Stream-level tests do not establish OS API or packaged-app acceptance.

</details>
