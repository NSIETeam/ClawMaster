# Agent Note: 清理工作树之前先为未提交成果建档

Status: implemented

[English](2026-09-22-worktree-inventory-before-cleanup.md) | 中文

## 问题

桌面检出里积累的工作比评审速度更快：整改基线记录了 59 项已跟踪改动与 126 个未跟踪条目，而本机安装的应用已经运行更新的构建，同时该检出里还保存着从未提交过的唯一副本。在没有书面清单的情况下整理这些内容，会删掉没人分类过的文件；而仓库与发布工具都无法凭证据回答"现在有哪些未提交内容、它的备份在哪里"。

## 决定

`apps/desktop-tauri/scripts/worktree-inventory.mjs` 为检出生成清单，并把未提交成果归档到清单旁边；它从不写入、暂存或删除所读取的检出中的任何内容。

- `captureWorktreeInventory` 读取 `git status --porcelain=v1 -z --untracked-files=all`，并描述每个条目：状态、类型、大小、mtime，以及对 64 MiB 及以下文件计算的 SHA-256 摘要。符号链接记录目标而不跟随；目录条目只登记自身，不向下遍历。
- Porcelain 输出按原始内容读取，不做裁剪。Git 把「仅未暂存的改动」标为 ` M`，裁剪缓冲区会让每条路径整体错位一个字符；`gitRawText` 正为此存在。
- `writeInventory` 同时产出供工具消费的 `worktree-inventory.json` 与供人阅读的 `worktree-inventory.md`，两者都列出每条路径。空小节保留可见，而不是被省略。
- `archiveUncommittedWork` 写出已跟踪改动的二进制补丁，以及已跟踪与未跟踪文件的 tar 包，使备份不依赖检出本身保持完好。
- `runWorktreeInventory` 是 CLI 与测试共用的唯一入口，因此被验证的路径就是交付的路径。

## 后果

清单是证据，不是权威：它记录的是捕获时刻检出里有什么，没有任何环节会重读它来决定可以删除什么。超过大小上限的文件其摘要为 `null`，读者必须把它当作"此处未做摘要"，而不是"未变更"。

删除或提交这些被建档的工作仍由人决定；本工具自身不增加任何清理步骤。归档落在给定的输出目录，默认 `.dsh-build/worktree-inventory`，该目录已被构建来源记录忽略。
