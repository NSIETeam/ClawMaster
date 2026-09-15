---
description: "ClawMaster update-server configuration, signed release synchronization, atomic publication and recovery."
---

# ClawMaster update server

English | [中文](README.zh.md)

## Summary

The update server serves signed desktop update files over HTTPS. GitHub remains the build and release source. A separate synchronization service checks the latest stable release, verifies its files, and publishes a complete version without building, signing or releasing an application. The [desktop README](../README.md#release) owns client update consent and version selection.

## Table of Contents

- [Endpoints and clients](#endpoints-and-clients)
- [Server configuration](#server-configuration)
- [Publication and failures](#publication-and-failures)
- [Verification and recovery](#verification-and-recovery)
- [Dev Note](#dev-note)

<a id="endpoints-and-clients"></a>
## Endpoints and clients

The primary manifest is `https://8.140.52.117/updates/clawmaster/latest.json`. Its artifact URLs use `https://8.140.52.117/updates/clawmaster/versions/<version>/<original-filename>`. The native configuration retains the public GitHub Latest manifest as a fallback. A successful response from the primary endpoint does not trigger a comparison against the fallback; operators must monitor synchronization freshness separately from HTTPS availability.

Already installed `0.2.1` binaries use their compiled GitHub endpoint. The server does not change those binaries or their DSH configuration. A later native release can deliver the configured server endpoint; mirroring an existing release does not publish such an update or rewrite GitHub release attachments.

The mirror contains the five updater targets: Windows x64 NSIS, macOS x64 and arm64 application archives, Linux x64 AppImage, and Linux x64 DEB. It is not the download catalog for DMG files or Android installers.

<a id="server-configuration"></a>
## Server configuration

The [service](clawmaster-updates.service) runs [the synchronizer](../scripts/sync-updater-channel.mjs) as the dedicated `clawmaster-updates` user. Its scripts and pinned public key reside under `/opt/clawmaster-updates`; writable state resides under `/var/lib/clawmaster-updates`. The server needs Node.js, minisign, aria2, systemd, flock, and outbound HTTPS access to GitHub release metadata and assets. Signing private keys are not required.

| Synchronizer option | Meaning |
| --- | --- |
| `--state-dir` | Absolute state directory; only its `public` child is served. |
| `--public-key` | Absolute path to the pinned Tauri release public key. |
| `--base-url` | HTTPS channel prefix, excluding `/latest.json` and `/versions/<version>`. |
| `--repository` | GitHub source repository; defaults to `NSIETeam/ClawMaster-Desktop`. |
| `--minisign` | Signature-verifier executable; defaults to `minisign`. |
| `--aria2` | Optional segmented downloader for the five large artifacts; the deployed service uses `/usr/bin/aria2c`. |

The [manifest generator](../scripts/generate-updater-manifest.mjs) also accepts `--asset-base-url` for an exact HTTPS version directory, such as `https://8.140.52.117/updates/clawmaster/versions/0.2.1/`. This differs from the synchronizer’s channel-level `--base-url`. Omitting the generator option preserves GitHub download URLs; supplying it preserves filenames and signatures while replacing their URL prefix. Credentials, query strings, fragments and ambiguous path segments are rejected.

The [timer](clawmaster-updates.timer) checks hourly with up to five minutes of randomized delay and catches up after downtime. The service acquires a nonblocking flock before synchronization; every manual invocation must use the same lock. The service has a 45-minute execution limit, a 512 MiB memory limit, a 2 GiB per-file limit, no privilege escalation, private temporary storage, read-only system paths outside its managed state, and inaccessible home directories.

The segmented downloader retains TLS verification, disables user configuration and netrc loading, and uses the system resolver. Its process deadline kills and awaits the child before staging cleanup. Every completed file must match the release size, checksum and signature.

The [Nginx configuration](clawmaster-updates.nginx.conf) mounts only the update prefix inside the existing HTTPS virtual host. It serves the stable manifest without caching and version files with one-year immutable caching. Directory listings and requests outside the declared update paths are rejected. The independent [installed-client plugin](../../../frontends/updates/README.md) uses `/components/catalog.json` and its detached `.sig`, immutable `/components/artifacts/` files, and versioned `/components/installers/` utilities. Component catalogs are signed before deployment; the server holds only their public key. Native synchronization does not write those component paths. TLS certificate issuance and renewal remain the existing virtual host's responsibility; clients retain certificate verification.

<a id="publication-and-failures"></a>
## Publication and failures

The synchronizer accepts a published stable GitHub release and rejects prereleases and version rollback. It downloads source metadata, checks the selected files against the release's SHA-256 list, and verifies all five updater signatures against the pinned key. A release-provided key cannot replace the local trust anchor. Artifact filenames, signatures and payload bytes remain unchanged; only manifest download URLs point at the mirror.

Downloads and verification occur outside the public directory. The completed version directory moves into the public tree before an atomic replacement of `latest.json`. Existing version files are immutable. The same version is revalidated before a no-op; a completed version left by an interrupted publication can be promoted without downloading it again. Source manifest, checksums and selected GitHub metadata remain under the private `evidence/<version>` directory.

A failed download, checksum, signature or publication leaves the last published manifest in place. The GitHub release-metadata request has a 30-second limit and each file download has a ten-minute limit. The script performs one synchronization; the timer owns subsequent attempts. A server that cannot reach GitHub can continue serving its published files but cannot discover a new release.

<a id="verification-and-recovery"></a>
## Verification and recovery

Service success establishes synchronized files, not successful installation on every platform. Operators inspect the timer and service status, confirm the HTTPS manifest's version and cache headers, and verify all five URLs against the published bytes and signatures. Native first launch, update consent, installation and restart remain platform acceptance work.

Stop the timer before changing service code, trust material or publication state, and preserve the current state directory and Nginx configuration. A failed deployment can restore those files and resume synchronization. An older stable pointer is not an automatic application downgrade: both the server and client reject lower versions. A corrected release uses a new stable version. Do not overwrite immutable files, disable TLS verification, or replace a signing key to make a rejected release pass.

The [publication decision](../../../.agents/notes/implemented/architecture/2026-09-15-desktop-self-hosted-update-channel.md) records trust ownership and the alternatives to copying verified release bytes.

<a id="dev-note"></a>
## Dev Note

None.
