# Agent Note: 发布构建门禁与暂存资产脚本

Status: implemented

[English](2026-09-22-release-stage-script-and-version-gate.md) | 中文

## Problem

`.github/workflows/desktop-release.yml` 中的两个缺陷只能在真正尝试发布之后才会暴露，而第二个缺陷又只有在第一个修好之后才有可能暴露。

提交 `85e87e41bc` 为 `Stage release assets` 步骤增加了对 macOS 磁盘镜像的 LZMA 重压缩，但把 macOS 分支末尾的三行及其右花括号又保留了一份，且没有补上对应的左花括号。该步骤的 PowerShell 文本因此有 8 个 `{` 与 9 个 `}`。PowerShell 拒绝解析这样的脚本，于是这一步在每一个 runner、每一个平台上都会失败，根本来不及把任何安装包复制进 `release-assets/`。畸形行位于 `elseif` 分支内部，所以该故障看起来像只影响某个平台，实际并非如此；该提交之后没有产生任何 tag，因此没有任何构建执行过它。

另一个缺陷是：没有任何环节把发布版本与用户已经拥有的版本作比较。提交 `1faa6a869c` 把 `apps/desktop-tauri/version.json` 从 `0.2.8` 改回 `0.2.3`，而 `desktop-v0.2.7` 已经发布。`release-channel.mjs` 只比较 tag 与包版本，因此它接受了 `desktop-v0.2.3` 的构建，而工作流从未调用 `desktop-version.mjs --check` —— 那个检查只为 `prepare-dist.mjs` 和 Cargo 构建脚本而写。

## Decision

本决策扩展 [桌面版本唯一来源](2026-09-18-desktop-version-single-source.zh.md)，版本文件及其同步由该决策负责。

`Stage release assets` 只保留一份 macOS 收尾代码：磁盘镜像重压缩、磁盘镜像复制，以及带签名的更新包归档。

`Validate release version` 在两个平台构建之前依次运行三项检查：`desktop-version.mjs --check` 要求 `version.json`、`package.json`、`Cargo.toml`、`Cargo.lock` 中的 `dsh-desktop` 条目与 `tauri.conf.json` 一致；`release-channel.mjs` 要求 tag 指向该版本与对应通道；`release-version-guard.mjs --check <tag>` 要求该版本领先于同一 `major.minor` 线内所有已发布的 `desktop-v*` tag。该守卫从检出的仓库读取 tag 列表，因此依赖构建任务本就请求的 `fetch-depth: 0`，并排除正在构建的那个 tag，使候选分支可以先打 tag 再构建。

`desktop-version.mjs` 新增了锁文件，使其自身的 `sync` 命令能产出一棵可发布的源码树。一次版本提升会写入四个文件，否则工作流中的 `cargo test --locked` 会拒绝这次提升留下的锁文件。该命令只改写 `dsh-desktop` 条目，缺少该条目的锁文件会直接失败（fail closed）。

`release-version-guard.mjs` 把每个 tag 解析为它所发布的程序版本，把 `-release` 展示后缀视为同一个版本，将预发布版本排在对应正式版之前，并对无法解析的 tag 直接失败（fail closed）。`release-workflow.test.mjs` 拒绝任何花括号不配对的 PowerShell 步骤，并以修复前 `Stage release assets` 的文本作为反例；在 runner 具备 `pwsh` 时，它还会用 `pwsh` 解析每一个 PowerShell 步骤。

## Alternatives considered

**只按 `release-channel.mjs` 那样比较 tag 与版本。** 彼此一致的 tag 与版本仍可能共同指向一个比最新已发布版本更旧的程序。只有 tag 列表能区分「向前发布」与「重发旧版本」。

**统计工作流文本中的每一个花括号。** 引号字面量中的花括号会造成误报。该检查先剥离同一行内的单引号与双引号字面量，而 `pwsh` 解析才是 CI 上的权威检查。

**拒绝与已发布版本相同的版本号。** `desktop-v0.2.0` 与 `desktop-v0.2.0-release` 都指向程序版本 `0.2.0`，且仓库两者都发布过，因此相等是被支持的重发模式。守卫只拒绝落后于已发布集合的版本。

**跨版本线一并比较。** 本仓库重置过桌面版本线：`docs/DEFECTS-DAWN.md` 把「desktop 0.0.1beta（版本重置 2026-09-21）」记录为跟踪基线，重置之后新版本线的每个版本都落后于 `desktop-v0.2.7`。跨版本线比较会拒绝整条新版本线，因此守卫把比较范围限定在候选版本所属的 `major.minor` 线内。同一条线内部被误改回退——即 `1faa6a869c` 的状态——仍会被拒绝。

## Consequences

版本落后于最新已发布 tag 的发布候选，现在会在各平台构建的第一步就失败，而不再产出会让安装它的用户降级的安装包。提升桌面版本号因此成为工作流明确声明的发布前提，而不是它假定的约定。

花括号检查只覆盖 PowerShell 文本，而 `pwsh` 解析在 CI 上运行，在没有 PowerShell 的检出中不会执行。两项检查都不证明某个平台安装包已在真实受支持的机器上完成签名、安装、重启或回滚。

## Verification

`node --test apps/desktop-tauri/scripts/release-version-guard.test.mjs apps/desktop-tauri/scripts/release-workflow.test.mjs` 通过，`apps/desktop-tauri` 的 `npm run test:update-manifest` 已包含这两个文件。面对本检出中 18 个已发布的 `desktop-v*` tag，守卫会拒绝 `1faa6a869c` 造成的状态并输出 `Desktop version 0.2.3 is behind the published 0.2.7 in the 0.2 line`，同时接受该线的下一个版本 `0.2.8` 与另一条线的发布版本 `0.0.1`；工作流会在两个平台构建前复现同样的三项结果。
