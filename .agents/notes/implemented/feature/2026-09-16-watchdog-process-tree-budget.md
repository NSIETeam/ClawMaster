# WatchDog admission observes child-process RSS

English | [中文](2026-09-16-watchdog-process-tree-budget.zh.md)

The runtime governance plugin now reports the Host RSS separately from the observed RSS of its process tree. On POSIX hosts it reads fixed `ps` columns, follows parent-child links from the Host PID, and returns a null observation when the table is unavailable or the root is absent. Windows remains explicitly unsupported by this observer until a native process-table provider is wired.

Heavy tools are admitted only when both the Host budget and the configured process-tree budget are below their thresholds. The observer is injected in tests, status remains read-only, and an unavailable process table does not create a fabricated whole-machine limit. The default process-tree budget equals the Host RSS budget and can be changed with `maxProcessTreeRssMiB`.
