# Agent Note: Desktop Optional Component Recovery

Status: implemented

English | [中文](2026-09-17-desktop-optional-component-recovery.zh.md)

## Decision

ClawMaster keeps the core desktop usable when a feature bundle is unavailable. Profile preparation omits invalid or missing optional bundles and logs the component failure. Startup recovery retries after disabling only allowlisted feature entries. The main frontend, desktop policy, Guard, permission, and approval entries are not recoverable; their failures remain fatal.

## Alternatives considered

Disabling every loader entry after a startup error was rejected because it could turn a broken or missing security component into an apparently successful launch. Requiring every bundled feature package to validate before profile creation was rejected because a missing Notes, Office, connector, or updater bundle should not prevent the rest of ClawMaster from opening.

## Consequences

Unavailable optional components do not appear in the active desktop profile until a later launch can validate them. An optional plugin that fails during activation is disabled for the recovery launch, and the desktop shell reports its loader id. Adding a desktop feature requires an explicit decision about optionality and, when startup recovery is appropriate, its loader id must be added to the Rust allowlist. Core application and security entries remain fail-closed.

## Verification

`desktop-defaults.test.mjs` verifies that a missing or wrong-version optional bundle is omitted while the core profile is written, and that a missing frontend bundle still fails. Supervisor tests verify that optional integrations can be disabled while frontend, Guard, sandbox, approval, permission, and unknown entries cannot. Installed-platform recovery and the user-visible status for each disabled feature remain part of desktop acceptance.
