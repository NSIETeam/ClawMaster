# Agent Note：Windows 进程树 RSS 观察

Status: implemented

[English](2026-09-16-watchdog-windows-process-tree-rss.md) | 中文

## 问题

WatchDog 的进程树预算需要在 Windows 上观察常驻内存。仅有 Host RSS 无法计入工具启动的子进程，而不完整的原生读取可能低报整棵树的占用。

## 决策

本地子进程提供方通过既有 Toolhelp32 快照与 PSAPI `GetProcessMemoryInfo` 工作集读取公开 Windows 进程树 RSS。聚合从 Host PID 沿父子链接遍历，并且对 Host 及每个可观察后代只计数一次。

聚合采用失败收紧语义。根进程缺失、进程不可读、字节数无效或不安全，以及原生绑定失败都会产生不可用观察。进程树观察不可用时，运行时治理继续保留独立的 Host RSS 预算；它绝不会替换为整机数值或部分进程树的和。

ClawMaster 前端声明该提供方依赖，并兼容缺少新导出的旧提供方，继续返回不可用结果。桌面工作区锁从内置 DSH 源码解析提供方，因此发布构建可以获得原生实现，无需 shell 命令或用户安装的监控工具。

## Alternatives considered

继续让 Windows 不受支持会使生产资源预算看不到子进程。读取 `tasklist`、PowerShell 输出或整机计数器会增加外部依赖，或错误描述 Host 进程树。复用既有原生提供方可以让进程身份和内存观察共用一套 Win32 实现。

## 后果

受保护的 Windows 进程可能让进程树预算暂时不可用。这保留了真实状态，同时继续执行 Host 预算与重型操作并发限制。Koffi ABI 与受保护进程行为仍需要真实 Windows runner 验证；非 Windows 测试覆盖聚合和所有失败分支。

## 验证

`pnpm exec vitest run packages/subprocess/subprocess-local/tests/windows-inspector.spec.ts` 通过 13 项测试；非 Windows 环境跳过平台原生套件。`pnpm exec tsc -p packages/subprocess/subprocess-local/tsconfig.json --noEmit`、`npm run typecheck --prefix frontends/dsh` 与 `npm run build --prefix frontends/dsh` 均通过。前端包锁定 `@deepseek-ai/dsh-subprocess-local@0.1.5-rc.2`；桌面裁剪锁定从工作区解析该提供方。
