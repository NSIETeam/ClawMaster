---
description: "收集并验证已安装 ClawMaster 候选版本的桌面及 Android 交付证据。"
---

# 已安装版本验收

[English](README.md) | 中文

## 概述

每个候选版本都需要来自已安装应用的证据。[验收校验器](../scripts/release-acceptance.mjs)将候选版本和完整源码提交绑定到该版本要求的安装器检查通道，验证所保留安装包及证据的哈希，并拒绝缺失的必需检查。Beta 版本要求 Windows x64 NSIS 和 Apple Silicon DMG；其他版本要求完整五通道矩阵。它验证证据的完整性和完备性，不能把编造的测试报告变成真实设备观测。

## 目录

- [收集证据](#collect-evidence)
- [必需观测](#required-observations)
- [验证发布准备状态](#validate-publication-readiness)
- [当前验证限制](#current-verification-limits)

<a id="collect-evidence"></a>
## 收集证据

使用 `--template --version <candidate> --commit <full-commit> --upgrade-from <supported-old-version>` 创建模板；为每个支持的旧版本重复指定 `--upgrade-from`。工具向标准输出写入 JSON，并将所有安装器标为 `not-run`。将清单及对应文件存入私有证据目录。凭据及真实业务对话不属于验收产物。

安装器检查通道涵盖 Apple Silicon DMG、Windows x64 NSIS、Linux x64 AppImage、Linux x64 DEB 及 Android 通用 APK，不包含 Intel Mac。记录实际平台、架构、系统版本、隔离环境、已安装程序版本及源码提交。对每份精确安装包计算哈希；构建成功、解压产物或另一平台窗口均不能证明安装后结果。

完成的通道包含 `artifact: { file, sha256 }`、`signature` 结果、`scenarios`、每个声明旧版本对应的 `upgrades` 条目，以及 `integrations`。每个通过结果至少保留一个 `{ file, sha256 }` 证据描述。路径相对于所选产物根目录；链接、路径穿越、空文件及字节变化均被拒绝。保留足以供独立审核者复现结论的命令、截图、机器可读观测和日志。[校验器测试](../scripts/release-acceptance.test.mjs)描述解析案例，其中的合成文件不能充当发布证据。

<a id="required-observations"></a>
## 必需观测

桌面检查涵盖安装、干净用户配置首次启动、断网恢复、正常退出及重启、中文及空格路径、支持旧版本升级、卸载数据策略、更新回滚、可选组件故障恢复、批准/拒绝、取消，以及失败写入没有部分提交。可选组件场景会禁用一个功能组件，并验证应用仍保持打开、受影响功能明确显示不可用、核心会话及其他无关功能仍可继续使用。每项升级记录设置、凭据、会话及业务数据的保留结果。Android 另行负责批准、拒绝、取消及对话持久化检查；不推定具备桌面 Office 或 Shell 行为。

发布者校验在 macOS 使用 `developer-id-notarized`、Windows 使用 `authenticode`、Linux 发布包使用 `minisign`、Android 使用 `android-apk`。记录观测到的发布者身份并保留系统校验输出。macOS 临时签名与 Tauri 下载签名不能替代 Developer ID、Apple 公证或 Authenticode。证书缺失应标为 `blocked`，并在 `reason` 中说明缺少的前置条件。

每个通道都需要真实模型请求，且使用该平台的 OS 安全凭据库取得密钥。桌面通道还需要在已安装版本中通过 Native RPA 点击浏览器并保留已批准的执行证据；选定聊天的微信读取单独保留账号授权证据。每个桌面通道都要分别验证微信、飞书、钉钉、QQ 和企微的阻断或已连接状态。渠道未配置时，只有应用显示 `blocked`、说明不可用原因且未谎称连接成功，并保留对应证据，UI 检查才算通过；已连接渠道需记录明确的测试账号授权及精确客户端版本。此矩阵不授予个人账号访问权，也不授权收集真实消息。

Beta 版本在没有授权测试账号时，可以明确将 `wechat-selected-read` 和五个 IM 界面集成标为 `not-run`。验收清单必须写明是主动省略了实时连接器凭据；模型、Office、Native RPA、生命周期、升级、网络恢复、审批、回滚和写入安全检查仍然是强制项。

<a id="validate-publication-readiness"></a>
## 验证发布准备状态

运行 `node apps/desktop-tauri/scripts/release-acceptance.mjs --manifest <manifest.json> --root <artifact-directory> --commit <full-commit> --version <candidate>`。验收不完整时，正常命令以失败状态退出。`--report-only` 为准备过程返回缺失项；其成功退出不代表允许发布。源码提交必须标识产生安装包的候选版本，不能改成后续保存验收报告的提交。

[Windows 原生收集器](../scripts/verify-windows-native.ps1)与 [macOS 收集器](../scripts/verify-macos-native.mjs)提供各自文档约定的启动、进程归属及重启观测。报告会保留启动和就绪时的可执行文件路径及进程创建身份；后续采样必须仍然匹配，因此不能用相同的数字 PID 隐藏 PID 复用或进程替换。将其输出与其他必需场景一并保留。校验器不会用构建通过补齐缺失字段，也不会发布、修改版本、安装程序或迁移用户数据。

<a id="current-verification-limits"></a>
## 当前验证限制

校验器及拒绝测试在本地运行。完整安装证据、Developer ID／公证凭据、Windows 发布者证书、Android 设备覆盖及授权集成测试账号仍是外部前置条件。当前桌面发布工作流的构建及原生冒烟结果本身不能提供完整矩阵。发布任务要求存在 `release-assets/acceptance-manifest.json`，并在生成更新元数据或上传版本前，对标签提交与版本运行严格校验。缺失或不完整的证据会阻止发布。生成校验和后，`verify-release-assets.mjs` 会在上传前验证当前资产集合、`SHA256SUMS.txt` 中每个文件的字节，以及每份公开构建记录的源码树和组件清单。它会针对最终目录重新运行严格验收，并要求各通道指向准确的公开安装包，包括 DMG 和 APK；重新生成校验和不能授权替换安装包。最终资产集合为平铺目录，因此需要把经过审核的证据文件暂存到发布目录根部，并在清单中使用对应文件名。`test:update-manifest` 使用缺失及不完整的证据执行实际工作流 shell 步骤，验证其不能进入发布。当前构建任务不能收集完整 manifest；在提供经过独立审核的证据产物前，发布仍处于阻断状态。
