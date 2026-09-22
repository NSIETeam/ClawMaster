# Agent Note: Make every execution surface name its gate or its gap

Status: implemented

English | [中文](2026-09-22-execution-surfaces.zh.md)

## Problem

The product can change the operator's machine in many ways — writing a file, running a shell command, saving an Office document, writing an enterprise record, driving the desktop, accepting an update — and each of those is gated by a different module. Nothing listed them together, so "is this supervised?" could only be answered by reading every module in turn. An unexamined surface looked exactly like an unguarded one, and a surface whose gate lives in a component outside this checkout looked like it had no gate at all.

## Decision

`apps/desktop-tauri/execution-surfaces.json` records each surface as one entry: what it can change (`surface`), the module that refuses it (`enforcer`), where the permission being exercised comes from (`authorization`), the enforcement mechanism (`mechanism`), the test that exercises it (`evidence`), and its `status`.

`authorization` is either a repository path or an explicit `{"external": …}` supplier, because some gates are decided by a component the checkout does not contain: the Office editor's saver and the updater's signature trust root are both supplied from outside.

`apps/desktop-tauri/scripts/execution-surfaces.mjs` checks the inventory against the checkout. `status` has three values. `enforced` requires an enforcer, an authority, a mechanism from a closed set, and at least one evidence path. `unenforced` requires a stated reason and forbids naming an enforcer or a mechanism. `unclassified` requires a stated reason that says what this inventory has not established. A missing, absolute or empty path fails; a duplicate id fails; an unknown status, mechanism or authority form fails.

The third status is the point of the design. An inventory offering only `enforced` and `unenforced` would force a guess about every surface nobody had examined yet, and a guess reads as an answer.

## Consequences

The shipped inventory is deliberately partial: six surfaces name a gate; network egress is recorded as unenforced, quoting the sandbox module's own statement that network and process visibility are outside its vocabulary; and automated code execution, MCP tool calls and runtime plugin mounts are recorded as unclassified together with what is missing. Adding a surface to the product without adding it here is not detected — the inventory only guarantees that every surface it does list is accounted for.

`enforced` is a claim that a gate exists, not that the gate is sufficient. The checker resolves paths and field forms; it does not judge whether the mechanism an entry names actually stops the change it claims to stop. That judgement stays with review, the same limit the capability ledger records for its own evidence paths.

Requiring an evidence path makes a gate with no test visible, which is why several entries name a test rather than the workflow step that calls the same code.
