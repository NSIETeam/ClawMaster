# Agent Note：Windows 原生启动身份就绪

Status: implemented

[English](2026-09-16-windows-native-identity-startup-retry.md) | 中文

## 问题

Windows 原生验收收集器可能在第二次桌面启动中提前拒绝有效进程，因为 `Process.Start()` 返回时 `StartTime` 或 `MainModule.FileName` 还不可读取。

## 决策

收集器在宣告身份不可用前，最多十秒轮询由 `Process.Start()` 返回的受管 `Diagnostics.Process`。进程退出后立即停止轮询，并继续在每次就绪采样中执行既有的 PID、创建时间与可执行文件路径检查。

## Alternatives considered

按名称查找可执行文件，或在没有创建时间的情况下接受 PID，会掩盖替换和 PID 复用。增大全局启动超时不能解决即时身份竞争，还会不必要地延迟真正的失败。

## 后果

短暂的 Windows 进程元数据竞争不再造成第二次启动的误报。进程若在身份可读前退出，验收仍会失败，并通过它的受管句柄清理。

## 验证

修改仅涉及 `verify-windows-native.ps1`。PowerShell 执行由 GitHub 托管 Windows 发布任务负责；当前 macOS checkout 没有 `pwsh`，因此真实双启动验收仍等待该任务执行。现有 `windows-native-evidence` 测试继续验证收集的身份和重启证据约定。
