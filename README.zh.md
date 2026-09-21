---
description: ClawMaster WatchDog 桌面版下载、首次使用与 DSH 运行时开发入口。
---
# ClawMaster

[English](README.md) | 中文

![ClawMaster](apps/desktop-tauri/app-icon.png)

## Summary

**开启AI时代的企业协作**

ClawMaster 通过 Tauri 桌面为 WatchDog 提供任务委托、审批与会话旁的成果查看空间。模型、Session、工具、审批和插件基础设施直接复用 DSH。

## 当前状态（内核代号 **Dawn**）

> **Agent 开工前必读**：先看 [docs/STATUS-2026-09-21.md](docs/STATUS-2026-09-21.md) 与
> [docs/DEFECTS-DAWN.md](docs/DEFECTS-DAWN.md)，再执行 `git log --oneline -20` 了解最近变化，然后才动手。

- 基线：dsh 0.1.5-rc.2（harness `72da6c767414dd30`）· desktop 0.2.3 · 会话库 93/93 健康
- 技能主动调取已验证（企业插件探针 10/10 通过）；在线技能 106 个
- 自愈：`session-doctor` 每 30 分钟自动运行（launchd `com.clawmaster.session-repair`）
- 已知缺陷与缓解：见 [DEFECTS-DAWN](docs/DEFECTS-DAWN.md) 的 D1–D12

## Table of Contents

- [下载安装](#downloads)
- [首次使用](#first-use)
- [组件](#components)
- [开发](#development)
- [许可与上游](#licenses-and-upstream)

## Downloads

从 [GitHub Releases](https://github.com/NSIETeam/ClawMaster/releases) 中选择版本附件下载。每个版本附带 `SHA256SUMS.txt`；构建结果和发布说明列明各平台验证情况与签名状态。

| 系统 | 架构 | 安装包 |
| --- | --- | --- |
| macOS 11.0+ | Apple Silicon / Intel | DMG |
| Windows | x64 | NSIS EXE |
| Linux | x64 | AppImage / deb |

首次启动复用兼容的 Node.js 与 pnpm，缺失时下载，再安装生产依赖，因此需要联网。保留已有 DSH 主目录即可复用模型凭证、Session 和已安装插件配置。

<a id="run"></a>
## First use

1. 打开 ClawMaster，阅读 WatchDog 教程；可以跳过，也可以从设置重新打开。
2. 打开模型设置并配置提供商。已有凭证继续可用；完成教程不代表模型连接已通过测试。
3. 在 WatchDog 中描述期望成果。创建任务时系统会分配工作目录；仅打开应用不会创建默认 Workspace。
4. 检查审批请求，并在会话旁打开成果文件。关闭标签页或退出前先保存编辑。
5. 可选：在设置中接入协作渠道。二维码用于开始连接，平台确认后才代表连接成功。

## Components

编辑器和浏览器在右侧打开，终端在会话下方打开。[Office 组件](frontends/office/README.zh.md)在本地编辑和保存基础 DOCX、XLSX 与 PPTX，提供冲突保护并保留 ONLYOFFICE 声明与源码入口。CRM、ERP 的开关与入口位于组件设置中，并打开各自的右侧标签页。CSV/TSV 数据处理提供给 AI 工具使用，不设置独立数据处理页面。

桌面包含 Agent Teams、OpenViking Memory、Routing Suite、Better Sidebar 与 IM 集成。OpenViking 需要另行配置记忆服务。[桌面参考](apps/desktop-tauri/README.zh.md)列明插件版本与限制；[产品前端](frontends/dsh/README.zh.md)说明任务和业务组件行为。

<a id="run-from-source"></a>
## Development

先阅读[架构](docs/architecture.zh.md)、[开发指南](docs/development.zh.md)和 [Tauri 构建说明](apps/desktop-tauri/README.zh.md#build)。应用通过已有 `dsh` profile 启动。公开包名、插件接口、Session 格式和凭证存储继续保留 DSH 身份。

## Licenses and upstream

ClawMaster 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 [Tauri 桌面发行版](https://github.com/Sakana-yuyu/deepseek-harness-desktop)，保留其作者信息与许可声明。适用条款见根目录 [LICENSE](LICENSE)、各包许可及 Office 组件的[许可](frontends/office/LICENSE)。

## Dev Note

无。
