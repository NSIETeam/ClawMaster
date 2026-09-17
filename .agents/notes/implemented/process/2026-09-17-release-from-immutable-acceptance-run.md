# Agent Note: Publish only from immutable candidate run evidence

Status: implemented

English | [中文](2026-09-17-release-from-immutable-acceptance-run.zh.md)

## Problem

A tag build could enter publication in the same workflow run even though the accepted installation and integration evidence was not available to that run. Rebuilding during publication could also produce installer bytes that were never installed during acceptance.

## Decision

Tag pushes and default manual dispatches build and retain candidate artifacts without publishing. A separate publish dispatch names the successful candidate build run and a full commit SHA that contains the reviewed acceptance manifest and evidence files. The publisher checks the GitHub run's repository, workflow, completion, conclusion, run ID and source commit against the selected release tag, downloads artifacts from that run, and refuses evidence files that would overwrite original assets. The existing acceptance and final asset verifiers check the manifest version/commit, evidence digests, installer digests, build tree and exact release contents before upload.

The publish job uses the `desktop-release` GitHub environment so repository administrators can require an independent reviewer. The workflow records no cryptographic attestation of the truth of manually collected observations; the acceptance verifier checks their retained bytes and declared results. The repository must configure environment reviewers before treating that gate as independent approval.

The release matrix has no Android builder. Its required Android acceptance lane remains incomplete and blocks publication until a supported build and real-device evidence path exists. macOS Developer ID notarization and Windows Authenticode credentials also remain outside the current hosted build configuration.

## Alternatives considered

**Publish from the tag build job.** Native smoke reports and external device/account observations do not all exist when the tag build starts. The job could fail every time or accept evidence that was not tied to its installer bytes.

**Rebuild installers during the publish dispatch.** A new build can differ from the installers previously installed and observed, even at the same source commit. Publication therefore downloads the original artifacts by immutable run ID.

**Treat checksummed evidence as proof of the observation.** Hashes detect changed files but cannot establish that the written observation is truthful. Independent environment approval and real platform records remain necessary.

## Consequences

Build runs never publish by themselves. Operators retain their original candidate run through acceptance review and provide an immutable evidence commit at publication. Missing platforms, signatures, scenarios or integrations continue to block release. Repository environment protection, Android build support, notarization, Authenticode and real device/account acceptance require external configuration or platform access.
