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

The shipped inventory names nine gates and six gaps. The gaps are named individually because they are different gaps: a host-only plugin activates with no request and no approval, because that activation branch precedes the approval block; nothing decides admission for an MCP tool call, so the mount that chooses the servers and the call itself are one ungated seam; no destination allow-list exists for outbound traffic, and the single refusal that does exist covers one tool and checks an address class rather than a permitted host; model-written code is confined in a worker without any approval gating it, and the runtime's own module records that confinement as containment rather than as a gate; nothing gates a write to the user-layer harness configuration; and the guard's shell review reads a configured name list that omits the PowerShell provider the harness ships, so a deployment that mounts it runs PowerShell outside the review.

Admitting `pwsh` to the default list is left undone on purpose: it puts every Windows deployment into enforcing review by a classifier written for POSIX command lines, where a misread `high` finding holds a call for approval and a misread `critical` finding denies it. That belongs with whoever can measure the classifier on that platform, which is why the inventory states it as a gap instead of assigning a mechanism it cannot back.

Terminal input is a gate rather than a gap, and it is worth recording why the first version of this entry got that wrong. A guard review reads a configured tool name and one argument; the harness's `terminal_send` carries its command text in `text`, so no name added to that list reached it. The entry concluded from that that nothing stopped the change, which was false: `packages/terminal/terminal-bash/src/index.ts` confines the shell it spawns through the sandbox provider unless the policy is `danger-full-access`, and its own test asserts the confined argv. The review was the missing layer, not the confinement. The guard now maps a reviewed tool name to the argument carrying its command text, so both layers are present, and the entry names the confinement as the enforcer with the guard's test as additional evidence.

Adding a surface to the product without adding it here is not detected. The inventory guarantees that every surface it does list is accounted for, and nothing more.

`enforced` is a claim that a gate exists, not that the gate is sufficient. The checker resolves paths and field forms; it does not judge whether the mechanism an entry names actually stops the change it claims to stop. That judgement stays with review, the same limit the capability ledger records for its own evidence paths.

Requiring an evidence path makes a gate with no test visible, which is why several entries name a test rather than the workflow step that calls the same code.
