# Agent Note: Preserve updater preferences during legacy self-upgrade

Status: implemented

English | [中文](2026-09-18-updater-legacy-profile-migration.zh.md)

## Problem

Installed updater `0.1.0` and `0.1.1` profiles can contain user-selected channel settings or a disabled choice. Updating the updater changes its entry URL, while replacing the full profile row could erase those choices. Treating every extended row as an unknown edit also prevented these users from upgrading.

## Decision

Activation changes only the `name` scalar of the updater-owned profile row after the existing entry resolves to a verified installed component receipt. It preserves the row's `config` and `disabled` YAML bytes, which keeps explicit channel URLs and the user's disabled choice. The configuration must pass the current updater schema, `disabled` must be Boolean, and the row may contain only `id`, `name`, `config`, and `disabled`. Unknown fields or invalid configuration stop activation before the profile or operation journal changes and return offline recovery instructions.

Updater `0.1.0` and `0.1.1` defaulted to the legacy native manifest URL; `0.1.2` defaults to v2. A profile with no explicit channel keeps the new version's v2 default. An explicit URL is user configuration and remains unchanged. Activation records the full before and after profile text, so the existing approved rollback path can restore the prior entry and preferences together. Restart maintenance records `selected-unverified` for an explicitly disabled updater or a selected version older than `0.1.2`, whose code cannot send the current Host health receipt. This terminal state preserves the user's selection without claiming that the updater loaded or retrying an automatic rollback on every launch.

## Alternatives considered

**Replace the complete updater row.** This would silently discard custom channel configuration and `disabled: true`, so activation edits only the verified entry scalar.

**Guess how to convert unknown fields or URLs.** A future configuration key may change behavior, and a custom endpoint may be intentional. The migration therefore refuses unrecognized row fields or schema-invalid configuration and leaves the original bytes untouched.

**Install a second updater row.** The profile already identifies one updater owner, and duplicate rows can load conflicting versions. Migration switches the verified owner instead.

## Consequences

Known `0.1.0` and `0.1.1` rows can use the approved update and restart flow while preserving recognized settings. Disabled and old-version selections remain visible as unverified terminal operations until the user chooses an explicit rollback or newer activation. Unknown profile formats require an operator to stop ClawMaster, back up the profile and updater data, and restore a known-good profile backup or request administrator-led offline repair. Tests model both historical versions using the repository's component receipt and journal formats; they do not replace installed-upgrade acceptance on Apple Silicon, Windows x64, or Linux.
