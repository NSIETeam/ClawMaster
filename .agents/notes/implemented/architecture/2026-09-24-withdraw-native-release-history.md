# Agent Note: Withdraw prior native release history before resetting the desktop version

Status: implemented

English | [中文](2026-09-24-withdraw-native-release-history.zh.md)

## Problem

The public release history contained desktop and Android versions that the product owner judged unusable and requested to withdraw before restarting desktop numbering at `0.0.1`. Leaving their release metadata or native update paths available would let clients discover or download artifacts that were no longer approved for use.

## Decision

The GitHub desktop and Android releases and version tags in the approved reset scope are deleted while Git commit history, component versions, and unrelated tags remain. The new product target is desktop only. The legacy root native manifest and version routes are not served; the Nginx catch-all returns 404, while component and portable-kit routes remain. Public checks observed 404 for retired manifest routes and 404 or 410 for sampled withdrawn package URLs. Physical removal of every server-side legacy file has not been verified; recovery copies must remain outside public directories.

Installed builds with a compiled endpoint to the withdrawn root channel cannot discover a replacement endpoint through a server or profile change. Users of those builds install the supported desktop version manually. GitHub remains the source for build provenance and release artifacts; the update server only mirrors verified files.

The release remains unpublished until its tagged commit has exact-build CI artifacts, all four desktop targets pass installed acceptance, required platform signing and notarization are valid, and an independent release reviewer is configured. Resetting version numbers does not waive release acceptance.

## Alternatives considered

**Keep old release pages marked as broken.** Retained pages and tags would continue to advertise withdrawn artifacts and could be mistaken for supported downloads; the owner approved deleting those public version records while preserving commit history.

**Keep the legacy native endpoint for installed clients.** That would continue offering withdrawn packages and would preserve an automatic path into versions the owner rejected. The accepted trade-off is manual reinstall for clients whose binaries cannot change their compiled endpoint.

**Delete the entire update-server tree.** Component delivery and portable kits are independent supported paths, so only native desktop release endpoints are retired. The physical state directory cannot be claimed deleted without host-side verification.

## Consequences

Git history remains available for investigation, but the deleted releases and version tags no longer provide public install links. Historical manifest parsing and generation remain useful for offline validation and are not evidence that a legacy channel is served. Component and portable-kit distribution continue independently. Existing installs using retired native URLs require manual installation, and release publication remains blocked until the exact tagged build satisfies signed-platform acceptance.
