# Agent Note: Desktop fixture directory allocation

Status: implemented

English | [中文](2026-09-15-desktop-fixture-directory-allocation.zh.md)

## Problem

The desktop payload layout tests run concurrently. Naming their directories from a process ID and a wall-clock timestamp lets two fixtures choose the same path within one clock tick. Directory creation can then fail with `AlreadyExists` before the payload resolver is exercised.

## Decision

Each payload layout fixture owns a `tempfile::TempDir`. Its allocator atomically reserves the directory, and ownership releases it after the test. The dependency is test-only; packaged runtime behavior and resource lookup remain unchanged.

## Alternatives considered

Serial execution would leave the resource allocation dependent on scheduling. Adding a delay would leave it dependent on clock resolution. Neither establishes independent ownership.

## Consequences

The existing positive and rejection cases retain their assertions and may run concurrently on every desktop test host. The observed directory collision supplies the regression evidence; tests exercise the payload resolver without retesting the temporary-directory library.
