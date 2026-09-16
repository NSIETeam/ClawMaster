# WatchDog 准入检查观测子进程 RSS

[English](2026-09-16-watchdog-process-tree-budget.md) | 中文

运行时治理插件现在会分别报告 Host RSS 和观测到的进程树 RSS。在 POSIX 主机上，插件读取固定的 `ps` 列，按照 Host PID 的父子关系累加进程树；进程表不可用或根进程不存在时返回空观测。Windows 在接入原生进程表提供方前明确不启用这项观测。

重型工具只有在 Host 预算和可配置的进程树预算都未达到阈值时才会准入。观测器可在测试中注入，状态工具仍然只读；进程表不可用时不会伪造全机硬上限。默认进程树预算与 Host RSS 预算相同，可通过 `maxProcessTreeRssMiB` 修改。
