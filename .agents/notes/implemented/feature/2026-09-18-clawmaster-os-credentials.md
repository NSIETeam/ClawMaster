# Agent Note: ClawMaster stores DSH credentials in the operating system

Status: implemented

English | [中文](2026-09-18-clawmaster-os-credentials.zh.md)

## Problem

The desktop DSH profile's active credential provider stored model keys and plugin grants in a plaintext YAML file. A file-backed provider could also materialize credentials through environment files and the Windows-to-WSL launch path, leaving secrets outside the operating system's credential protection.

## Decision

The desktop profile replaces the DSH `credentials` service with `@clawmaster/dsh-credentials-keychain`. DSH model adapters and plugin consumers keep using `ctx.credentials`; the provider sends requests to the Tauri host over the dedicated `clawmaster-credentials/1` inherited-pipe protocol. The host stores values in macOS Keychain or Windows Credential Manager and fixes the native service identity. The provider keeps only credential-record names and kinds in `$DSH_HOME/.credentials-index.json`.

On first launch, the desktop supervisor copies inherited secret environment variables into the OS store with an atomic native create-if-absent operation on a background thread, so a locked or unavailable secure store cannot delay the Host. The provider imports supported records from legacy credential documents and the invocation and user `.env` files, then reads each stored value back. A WSL launch also supplies the canonical Windows DSH-home roots selected by the desktop resolver; the provider reads those files through the inherited host broker and removes them only after verified storage, without copying secret files into the Linux DSH home. It never replaces a non-empty native value, including during concurrent migrations. It removes a legacy source only after every secret has been verified and record metadata has been committed; dotenv cleanup removes only parsed secret assignments and preserves all unrelated bytes. A linked, malformed, oversized, or unreadable source stays in place. Secure-store or migration failure logs a value-free warning and does not prevent the DSH profile from starting; an operation that needs the store reports the failure to its caller.

## Alternatives considered

**Keep the DSH file provider and harden permissions.** File modes and ACLs protect at-rest data less directly than OS credential APIs and keep a plaintext secret file as the source of truth.

**Move only model keys and leave plugin grants in YAML.** DSH consumers share one credential provider, and grants contain tokens too; splitting storage would preserve the original exposure and duplicate migration behavior.

**Let the Node provider call OS credential APIs directly.** This would require platform-specific Node dependencies in the DSH runtime and would make the core package own desktop platform APIs. The existing Tauri host is the platform owner.

## Consequences

The actual model-request path resolves through OS storage without changing DSH consumer APIs. Desktop startup survives an unavailable secure store, while model calls and credential edits fail at the credential operation that needs it. Migration can leave old plaintext in place when verification or safe cleanup fails; users must resolve that warning before deleting the source. WSL mode depends on the Windows host broker and accessible Windows drive mounts. Standalone Linux support and native acceptance on both macOS and Windows require separate host implementations and platform tests.

## Testing

Focused provider tests cover the dedicated wire prefix and request/reply protocol, redacted native errors, dotenv cleanup, malformed dotenv preservation, unavailable-store startup, linked-file rejection, and migration from an explicit WSL-visible Windows root without creating Linux-home copies. Rust tests cover the WSL launch root argument. These tests cannot establish native Keychain or Credential Manager behavior in packaged applications or prove access to every WSL automount configuration.
