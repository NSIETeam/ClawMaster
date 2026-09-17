# Agent Note: WatchDog admission observes child-process RSS

Status: implemented

English | [中文](2026-09-16-watchdog-process-tree-budget.zh.md)

## Problem

Host RSS alone omits memory used by child processes, so a heavy tool can exceed the intended runtime budget while the Host process appears below its limit.

## Decision

The runtime governance plugin now reports the Host RSS separately from the observed RSS of its process tree. On POSIX hosts it reads fixed `ps` columns, follows parent-child links from the Host PID, and returns a null observation when the table is unavailable or the root is absent. Windows remains explicitly unsupported by this observer until a native process-table provider is wired.

Heavy tools are admitted only when both the Host budget and the configured process-tree budget are below their thresholds. The observer is injected in tests, status remains read-only, and an unavailable process table does not create a fabricated whole-machine limit. The default process-tree budget equals the Host RSS budget and can be changed with `maxProcessTreeRssMiB`.

## Alternatives considered

**Use Host RSS alone.** This misses memory held by child processes and can admit work after the total runtime tree exceeds its intended limit.

**Treat unavailable process data as zero or as whole-machine usage.** Zero would understate usage, while whole-machine usage would attribute unrelated processes to the Host; the observer reports no measurement when its process table cannot establish the Host tree.

**Claim the same process-tree measurement on Windows without a native provider.** The POSIX `ps` observer cannot supply Windows process ancestry, so Windows remains unsupported until an appropriate provider exists.

## Consequences

The admission decision uses Host and process-tree RSS as separate configured budgets. POSIX process-tree observations depend on the available process table; Windows does not receive this observation, and the design does not claim that child processes which detach from the parent tree are accounted for.
