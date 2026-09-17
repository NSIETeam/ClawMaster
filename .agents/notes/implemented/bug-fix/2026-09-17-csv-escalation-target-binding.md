# Agent Note: bind CSV write approval to the requested paths

Status: implemented

English | [中文](2026-09-17-csv-escalation-target-binding.zh.md)

## Problem

CSV writes can request a one-shot sandbox escalation. A generic approval reason does not identify which input, output and format the approval covers, and an asynchronous approval creates time for the caller's argument object to change.

## Decision

`csv_process` resolves its normalized operation before requesting approval and includes the input path, output path and format in the DSH approval reason. The tool runtime snapshots normalized arguments and escalation fields before awaiting approval, then rejects any changed operation before resolving files or writing. DSH tool dispatch passes the execution a stable argument value, so mutation of the caller's original object cannot redirect the approved output.

This rule applies to the CSV tool's one-shot escalation. It does not mediate arbitrary filesystem effects from other plugins or establish process isolation.

## Alternatives considered

- **Keep the generic approval reason.** The user cannot distinguish the file operation from the reason text alone, so the approval is less specific than the resulting write.
- **Treat the argument object as permanently immutable.** The runtime currently gives tools a stable value, but the explicit comparison preserves the approval binding if the caller boundary changes.
- **Claim string review as a sandbox.** A displayed path cannot prevent a different provider or same-process plugin from accessing files; DSH filesystem enforcement remains the mechanism for this tool.

## Verification

The DSH tool test checks that approval text names the exact source and destination, and mutates the original caller object while approval is pending to prove the write remains limited to the approved destination. Existing rejection, cancellation, missing-approval and out-of-workspace cases verify that those outcomes create no file.

## Consequences

- The approval record identifies the operation's source and destination.
- Changing operation parameters after dispatch cannot redirect a successful one-shot approval.
- This guarantee covers the DSH `csv_process` path and does not imply universal plugin, shell, RPA, Office or network enforcement.
