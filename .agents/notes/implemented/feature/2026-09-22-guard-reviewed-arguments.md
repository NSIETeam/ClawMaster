# Agent Note: Review a shell tool's command text wherever the tool keeps it

Status: implemented

English | [中文](2026-09-22-guard-reviewed-arguments.zh.md)

## Problem

The guard reviewed a configured list of tool names and read one fixed argument from each: `command`. Two gaps followed from that, and neither was visible in a log. A shell-capable tool outside the list was not reviewed at all — the call reached the pipeline as `unreviewed-tool` with no decision. And a tool inside the list whose command text lives in a differently named argument was not reviewed either, because the argument name was not part of the configuration: the installed harness declares `terminal_send` with `text: { type: 'string', required: true }` and submits Enter by default, so adding that name to the list would not have read anything.

## Decision

A `shellTools` entry is now either a bare tool name, reviewed through its `command` argument, or `{name, argument}` naming the argument that carries the command text for that tool. `shellCommandOf` resolves the argument from the entry and reads that one. The classifier, the decision mapping, and the probe are unchanged.

The default list becomes `['bash', 'shell', 'run_command', 'exec', { name: 'terminal_send', argument: 'text' }]`. An entry that is neither a non-empty name nor a usable `{name, argument}` pair makes the whole configured list unusable, so parsing falls back to the default list instead of accepting a partly read one — a list with an unreadable entry would otherwise silently narrow what is reviewed.

## Alternatives considered

**Keep a bare tool-name list and read only the fixed `command` argument.** That is the existing configuration form, but it cannot inspect `terminal_send`, whose command text is in `text`; naming the argument per tool closes that documented gap. Adding PowerShell to the same classifier was also rejected because no test measures its interpretation of PowerShell input.

## Consequences

Terminal input is reviewed as a command line, which is what it is: `terminal_send` submits the bytes it writes. The review sees one submission and nothing else — not the session's earlier output, not the line the text completes — so an unfinished line or a REPL answer is classified as the text it is. Ordinary input stays `low` and passes; anything else meets the same rules as `bash`.

PowerShell stays outside the default list. The classifier reads POSIX command lines and no case measures it against PowerShell text, so admitting `pwsh` would put every Windows deployment into enforcing review by unmeasured rules, where a misread `high` finding holds a call and a misread `critical` finding denies it. `apps/desktop-tauri/execution-surfaces.json` records that as an unenforced surface until someone measures the classifier on that platform.

A shell-capable tool absent from the list remains unreviewed and the omission remains silent. The list is the whole of what this plugin covers; adding a surface to the product does not add it here.
