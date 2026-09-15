---
description: "供 ClawMaster 从已解压 ZIP 检查并首次挂载已签名更新组件的说明，保留当前桌面及用户数据。"
---

# 把这份说明交给 ClawMaster

[English](README.md) | 中文

## 概述

请使用此接入包检查当前 ClawMaster 安装，向用户展示具体计划，并在用户确认该计划后安装更新器。报告成功前须验证实际加载情况。整个过程保留当前对话及用户数据。

## 目录

- [先检查](#inspect-first)
- [确认并安装](#confirm-and-install)
- [验证结果](#verify-the-outcome)
- [处理不兼容安装](#handle-an-incompatible-installation)
- [开发备注](#dev-note)

<a id="inspect-first"></a>
## 先检查

1. 阅读[接入包概述](../README.zh.md)，对照官方下载索引验证 ZIP 摘要，并定位已解压的接入包目录。根据 `dsh-launch.json` 的 `node` 字段解析已安装的 Node 可执行文件，不假定系统 PATH 选中了同一运行时。接入包不启动另一个 agent（智能体）应用。
2. 使用该 Node 可执行文件，在解压目录运行 `update-kit.mjs inspect`。工具使用当前环境、工作目录及平台已知启动记录位置；`--dsh-home`、`--runtime-root` 和 `--launch-manifest` 可提供明确位置。将记录用作位置线索，再验证实际运行时及 Cordis 包。记忆中的目录或版本不能证明兼容。
3. 仅读取本次操作需要的运行时及 profile 信息。不读取独立凭据文件，也不收集业务文档和笔记。不输出 profile 内容或其中的凭据，保留本地 profile 备份的私有权限。不卸载桌面、不删除主目录、不停止 Host，也不重启当前对话。
4. 展示所选主目录和运行时、更新器版本、已认证摘要、已查看的 profile 修订号、拟执行变更及备份范围。结果需要位置时，先向用户索取位置，再尝试安装。结果需要原生升级时，按下方原生流程处理。

<a id="confirm-and-install"></a>
## 确认并安装

1. 获取用户对已展示计划的明确确认。检查本身不构成安装授权。保留 `inspect.component.sha256` 和 `inspect.patchRevision`，以及检查时使用的明确位置参数。
2. 使用相同的 Node 可执行文件及位置，运行 `update-kit.mjs install --yes --expected-sha256 <inspect.component.sha256> --expected-patch-revision <inspect.patchRevision>`。占位符须替换为检查实际返回的值。由工具校验已签名本地文件，在 `DSH_HOME/clawmaster-updates/kit-backups/` 下保留三个 profile 文件的备份，并只挂载更新器的首个配置行。摘要或修订号改变时，需要重新检查并查看新计划。
3. 已有更新器时，使用它现有的命令和工具。不绕过该检查、不删除已有配置行，也不替换已有版本。更新器自身更新是独立的暂存操作，单纯重启不会应用它。
4. 保留安装结果及备份位置。接入包没有恢复命令；恢复前须另行查看当前 profile 及所保留备份。失败不构成覆盖 profile 或用旧备份覆盖后续编辑的授权。

<a id="verify-the-outcome"></a>
## 验证结果

安装后观测同一个 Host。确认 `/updates`、`clawmaster_updates` 及 `clawmaster_update` 已注册，再执行一次只读更新检查。区分 Loader 激活与服务器可用性：离线检查可以报告通道不可用，同时本地插件仍已加载。

报告已安装组件版本、观测到的命令或工具证据，以及仍需完成的步骤。不能把 `activation-pending`、已验证下载或已暂存的须重启更新描述为已生效的桌面升级。加载失败时，保留错误及 profile 修订号，供查看后决定恢复方式。

<a id="handle-an-incompatible-installation"></a>
## 处理不兼容安装

对于未知或不兼容的运行时，报告 `native-upgrade-required` 或 `needs-location`，并说明观测到的原因。不伪造兼容版本、不修改 DSH 核心包，也不强行将更新器挂载到该运行时。

使用已解析的 Node 可执行文件运行 `update-kit.mjs native`，获取在线准备计划。Linux 必须显式选择目标：AppImage 指定 `--native-target linux-x86_64`，DEB 指定 `--native-target linux-x86_64-deb`；选择前须验证当前安装格式。用户确认已展示计划后，使用相同位置及目标参数运行 `update-kit.mjs native --yes --expected-native-version <plan.version> --expected-native-digest <plan.digest>`。确认下载要求已存在的 DSH 主目录。该操作校验原生产物，返回具有安装文件后缀的文件，不启动安装器；macOS 返回 `.app.tar.gz` 应用归档，须另行安装。

报告所得文件，并说明仍需原生安装。请用户保存工作后另行完成原生安装；不要在此流程中启动安装器或重启当前对话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
