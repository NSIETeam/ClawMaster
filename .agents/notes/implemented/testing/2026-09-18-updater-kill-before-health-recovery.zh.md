# Agent Note: 验证更新器进程终止后的恢复

Status: implemented

[English](2026-09-18-updater-kill-before-health-recovery.md) | 中文

## Problem

更新器被选中与 Host 成功激活是两个不同事件。profile 已选择新版更新器后、更新器发送加载健康回执前，进程可能终止。在同一进程中模拟操作日志状态，无法证明进程重启后能恢复这段间隔。

## Decision

维护测试会启动独立 Node 进程，让它应用已批准的更新器选择，等待持久化的 `awaiting-health` 结果，再于健康确认前使用 `SIGKILL` 终止进程。新进程调用维护逻辑后必须恢复旧 profile，并保留 `rolled-back` 操作记录。POSIX 测试还会在零字节文件大小配额下运行维护逻辑：切换日志写入失败后，必须保留 `staged` 记录及旧 profile，并移除临时文件。README 记录了这些覆盖及其限制。

## Alternatives considered

**仅在测试进程写入模拟的 `switching` 操作日志。** 这能验证状态处理，但无法证明进程被杀后留下的持久状态可由后续进程恢复。现有状态测试仍覆盖原子替换前后的案例；子进程测试则覆盖选择更新后真实进程终止的情况。

**把文件大小配额失败当成整个磁盘写满或原生安装器证据。** 配额测试覆盖 `EFBIG` 原子写入失败，不等价于整个磁盘的 `ENOSPC`；这两项测试均未覆盖重命名过程中终止进程或真实安装包回滚。

## Consequences

“已选择但未确认”启动路径现有进程级恢复证据；受限文件大小配额下的切换日志原子写入失败，也会保留待处理记录和当前 profile。profile 替换期间整个卷 `ENOSPC` 及 macOS、Windows 或 Linux 原生安装中断，仍须通过平台故障注入和已安装产品验收确认。
