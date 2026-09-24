# Agent Note：Windows SQLite 测试清理

Status: implemented

[English](2026-09-24-windows-sqlite-test-cleanup.md) | 中文

## 问题

企业搜索查询计划测试把临时目录删除和数据库关闭注册成两个独立的 `node:test` 清理钩子，并先注册目录删除。Windows 在 SQLite 文件句柄仍打开时尝试删除文件，返回 `EBUSY`；POSIX 允许 unlink 已打开文件，因此掩盖了清理顺序缺陷。

## 决策

由一个清理逻辑负责先关闭 `DatabaseSync` 句柄，再递归删除独立临时目录。测试仍可并行执行，不依赖重试或 sleep。

## 考虑过的替代方案

**保留分开的钩子并重试删除：**这会保留不安全的资源所有顺序，并可能掩盖句柄泄漏。**在同一个钩子中先关闭再删除：**这会明确清理顺序，因此采用此方案。

## 结果

数据库和目录由同一清理逻辑负责其完整生命周期。测试不再依赖 POSIX unlink 行为，Windows 句柄占用也不需要延时或重试。
