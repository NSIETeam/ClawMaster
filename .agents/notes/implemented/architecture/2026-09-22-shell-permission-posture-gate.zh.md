# Agent Note: 把外壳的 CSP 与原生命令授权钉在已评审姿态上

Status: implemented

[English](2026-09-22-shell-permission-posture-gate.md) | 中文

## 问题

前端 README 用散文陈述桌面外壳的内容安全策略与原生命令授权：哪些指令把外壳与外部内容隔开，以及只有 `main` WebView 获得窗口与重启命令、Host 内容 WebView 一个也没有。当这份配置漂移时，没有任何东西会失败。新增一个 Tauri 权限、放宽 `script-src`、或在 capability 文件里加入第二个 WebView，都会静默发布，而评审者只能靠把两个 JSON 文件与一段散文对照阅读才发现分歧。

## 决定

`apps/desktop-tauri/scripts/shell-permission-posture.mjs` 将已发布的外壳配置与一份已评审姿态对照，并为每处分歧返回一条结论：`CLOSED_CSP_DIRECTIVES`（每条必须保持 `'none'`）、`SELF_ONLY_CSP_DIRECTIVES`（每条必须允许 `'self'` 且不得引入 `'unsafe-inline'`、`'unsafe-eval'` 或 `*`）、`REVIEWED_WEBVIEWS`、`REVIEWED_PERMISSIONS`。

这份姿态是需要给出依据的清单，而不是配置的副本：新增原生命令或放宽指令会让审计失败，直到同一改动同时扩展这些清单与它们所支撑的 README 句子。`auditShellPosture` 读取 `tauri.conf.json` 与 `capabilities/*.json` 下的每个文件，因此放进新 capability 文件的授权同样会被审计。

`apps/desktop-tauri/scripts/shell-permission-posture.test.mjs` 既对已发布配置运行审计，也对被篡改的副本运行：空或通配的策略、内联与 eval 许可、未评审权限、第二个 WebView，以及逐条删除每个封闭指令。每个非法用例都被拒绝，因此这道门槛无法通过变得宽松而通过。

## 考虑过的替代方案

**只在前端 README 中记录 Shell 姿态。** 评审发现，说明文字无法阻止新增 Tauri 权限、放宽 CSP 指令或增加 WebView 后悄然发布；因此选择可执行审计，直接拒绝每种偏移。

## 后果

该审计覆盖的是配置，不是强制力。它证明外壳被允许触达什么，以及评审集合之外的 WebView 都拿不到原生命令；它不证明 WebView 行为正确，也不约束 Node Host、原生进程树，或以用户权限运行的任何插件。这些边界仍由前端 README 的执行权限表记录，本审计不重述该表。

读取配置而非已构建应用，意味着某个打包步骤若改写 `tauri.conf.json`，被审计的文件就会与被发布的那份分离。桌面构建把该配置当作来源，因此今天两者一致。
