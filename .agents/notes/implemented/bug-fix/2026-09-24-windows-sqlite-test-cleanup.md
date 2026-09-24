# Agent Note: Windows SQLite Test Cleanup

Status: implemented

English | [中文](2026-09-24-windows-sqlite-test-cleanup.zh.md)

## Problem

The enterprise search plan tests registered temporary-directory removal before database close as separate `node:test` cleanup hooks. Windows attempted to remove the SQLite file while its handle was still open and returned `EBUSY`; POSIX permits unlinking an open file and concealed the ordering defect.

## Decision

Give the test one cleanup owner that closes its `DatabaseSync` handle before recursively removing the unique temporary directory. The focused test remains parallelizable and does not rely on retries or sleeps.

## Alternatives considered

**Keep separate hooks and retry removal:** this preserves the unsafe ownership order and can hide a leaked handle. **Close then remove in one hook:** this makes teardown order explicit and is the selected approach.

## Consequences

Cleanup owns the database and directory as one resource lifetime. The test no longer depends on POSIX unlink behavior, and Windows handle contention does not require delays or retries.
