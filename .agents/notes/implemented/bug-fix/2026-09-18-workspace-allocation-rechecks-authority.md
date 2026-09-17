# Agent Note: recheck workspace authority before registration

Status: implemented

English | [中文](2026-09-18-workspace-allocation-rechecks-authority.zh.md)

## Problem

Workspace allocation creates a directory before the registry adds it to DSH. Membership or the workspace-kind grant can be revoked while that asynchronous allocation is in progress.

## Decision

The route checks the authenticated caller and requested workspace kind before creating directories, then checks the same permission again immediately before `workspaceRegistry.create`. If the second check denies access or the authority is unavailable, the route does not register the workspace and removes the newly created empty leaf directory. It leaves pre-existing directories intact. The shared desk path serializes authorization, creation, registration and rollback, so one caller's cleanup cannot remove another caller's registered workspace. A policy change after the final check remains outside the authority's transactional guarantees.

## Alternatives considered

- **Authorize only before directory creation.** An authority change during filesystem work could otherwise be followed by an unapproved Workspace registration.
- **Register first, then recheck.** The registry would expose the resource before the route knew whether the caller still had access.
- **Delete every directory on denial.** Shared or pre-existing workspace paths must remain intact; cleanup is limited to an empty path created by this request.
- **Clean a shared desk without serialization.** A concurrent authorized caller could register the same path before a revoked caller rolls it back, so the rollback could delete the registered workspace.

## Consequences

- Revocation observed by the final check prevents Workspace registration.
- Authority errors remain fail-closed, and cleanup does not remove non-empty or pre-existing directories.
- The authority and filesystem registry do not share a transaction, so this check cannot prevent a policy change after authorization returns.
