---
description: "收集并验证已安装 ClawMaster 桌面版本的交付证据。"
---

# 已安装版本验收

[English](README.md) | 中文

## 概述

每个候选版本都需要来自已安装桌面应用的证据。[验收校验器](../scripts/release-acceptance.mjs)将候选版本和完整源码提交绑定到该版本要求的安装器检查通道，验证所保留安装包及证据的哈希，并拒绝缺失的必需检查。Beta 版本要求 Windows x64 NSIS 和 Apple Silicon DMG；桌面正式版要求 Apple Silicon DMG、Windows x64 NSIS、Linux x64 AppImage 和 Linux x64 DEB。Android 不属于此桌面发布工作流。它验证证据的完整性和完备性，不能把编造的测试报告变成真实设备观测。

## 目录

- [收集证据](#collect-evidence)
- [必需观测](#required-observations)
- [验证发布准备状态](#validate-publication-readiness)
- [发布者签名策略](#publisher-signature-policy)
- [当前验证限制](#current-verification-limits)

<a id="collect-evidence"></a>
## 收集证据

使用 `--template --version <candidate> --commit <full-commit>` 创建模板，并为每个支持自动升级的旧版本重复指定 `--upgrade-from <supported-old-version>`。重置版 `0.0.1` 可以不指定 `--upgrade-from`；这表示用户必须重新安装，且本版本不承诺保留旧版本数据。工具向标准输出写入 JSON，并将所有安装器标为 `not-run`。将清单及对应文件存入私有证据目录。凭据及真实业务对话不属于验收产物。

桌面安装器检查通道涵盖 Apple Silicon DMG、Windows x64 NSIS、Linux x64 AppImage 和 Linux x64 DEB，不包含 Intel Mac 与 Android。记录实际平台、架构、系统版本、隔离环境、已安装程序版本及源码提交。对每份精确安装包计算哈希；构建成功、解压产物或另一平台窗口均不能证明安装后结果。

完成的通道包含 `artifact: { file, sha256 }`、`signature` 结果、`scenarios`、每个声明旧版本对应的 `upgrades` 条目，以及 `integrations`。每个通过结果至少保留一个 `{ file, sha256 }` 证据描述。路径相对于所选产物根目录；链接、路径穿越、空文件及字节变化均被拒绝。保留足以供独立审核者复现结论的命令、截图、机器可读观测和日志。[校验器测试](../scripts/release-acceptance.test.mjs)描述解析案例，其中的合成文件不能充当发布证据。

<a id="required-observations"></a>
## 必需观测

桌面检查涵盖安装、干净用户配置首次启动、断网恢复、正常退出及重启、中文及空格路径、卸载数据策略、更新回滚、可选组件故障恢复、批准/拒绝、取消，以及失败写入没有部分提交。可选组件场景会禁用一个功能组件，并验证应用仍保持打开、受影响功能明确显示不可用、核心会话及其他无关功能仍可继续使用。每条已声明的自动升级路径都在对应版本矩阵中测试，并记录设置、凭据、会话及业务数据是否保留；重置版 `0.0.1` 不声明自动升级路径。

重置版 `0.0.1` 将 macOS 记录为 `ad-hoc-unnotarized`、Windows 记录为 `unsigned`，不宣称通过 Apple 或 Windows 发布者验证。保留能证明这两种状态的证据，并在 `signature.reason` 中说明信任限制。Linux AppImage 和 DEB 发布包仍须使用 `minisign`。之后的每个稳定版仍须在 macOS 使用 `developer-id-notarized`、Windows 使用 `authenticode`、Linux 使用 `minisign`。

每个通道都需要真实模型请求，且使用该平台的 OS 安全凭据库取得密钥。Native RPA 标为可用时，需在已安装应用中经批准完成浏览器点击，并记录所测浏览器版本；若本版本明确声明 Native RPA 不可用，则验收已安装应用显示阻断状态、说明限制并保留证据，不要求执行不可用的点击。选定聊天的微信读取单独保留账号授权证据。重置版 `0.0.1` 跳过 IM 界面集成检查。后续桌面版本会分别验证微信、飞书、钉钉、QQ 和企微的阻断或已连接状态。渠道未配置时，只有应用显示 `blocked`、说明不可用原因且未谎称连接成功，并保留对应证据，UI 检查才算通过；已连接渠道需记录明确的测试账号授权及精确客户端版本。此矩阵不授予个人账号访问权，也不授权收集真实消息。

<a id="validate-publication-readiness"></a>
## 验证发布准备状态

运行 `node apps/desktop-tauri/scripts/release-acceptance.mjs --manifest <manifest.json> --root <artifact-directory> --commit <full-commit> --version <candidate>`。验收不完整时，正常命令以失败状态退出。`--report-only` 为准备过程返回缺失项；其成功退出不代表允许发布。源码提交必须标识产生安装包的候选版本，不能改成后续保存验收报告的提交。

[Windows 原生收集器](../scripts/verify-windows-native.ps1)与 [macOS 收集器](../scripts/verify-macos-native.mjs)提供各自文档约定的启动、进程归属及重启观测。报告会保留启动和就绪时的可执行文件路径及进程创建身份；后续采样必须仍然匹配，因此不能用相同的数字 PID 隐藏 PID 复用或进程替换。将其输出与其他必需场景一并保留。校验器不会用构建通过补齐缺失字段，也不会发布、修改版本、安装程序或迁移用户数据。

<a id="publisher-signature-policy"></a>
## 发布者签名策略

重置版 `0.0.1` 可以在没有 Apple 公证或 Windows Authenticode 的情况下构建。其发布说明必须链接首次启动安全提示教程，公开文件必须通过 SHA-256 校验。此例外仅适用于精确版本 `0.0.1`，不会改变后续稳定版的要求。

macOS 需要将 base64 编码的 Developer ID `.p12` 保存为 `APPLE_CERTIFICATE`，导出密码保存为 `APPLE_CERTIFICATE_PASSWORD`，并将 App Store Connect 的 issuer、key ID 和 base64 编码的 `.p8` 内容分别保存为 `APPLE_API_ISSUER`、`APPLE_API_KEY` 和 `APPLE_API_KEY_CONTENT` 密钥。将精确的 Developer ID Application 身份设为仓库变量 `APPLE_SIGNING_IDENTITY`，将其 Team ID 设为 `APPLE_TEAM_ID`。构建会验证应用签名、Team ID、已钉附票据和 Gatekeeper 评估结果。

Windows 需要将 base64 编码的代码签名 `.pfx` 保存为 `WINDOWS_SIGNING_PFX`，密码保存为 `WINDOWS_SIGNING_PFX_PASSWORD`。将该证书的 40 位 SHA-1 指纹设为仓库变量 `WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT`。运行器只导入指纹固定的证书，Tauri 会签署应用和 NSIS 安装包，构建会用预期指纹检查每个生成的可执行文件。

后续稳定版的 macOS 必须配置上文所述 Developer ID 和公证信息；Windows 必须配置上文所述固定代码签名证书。现有 Tauri 更新密钥用于签署更新负载元数据，不能代替平台发布者证书。构建签名检查通过也不能代替上文的已安装应用场景和独立证据。

<a id="current-verification-limits"></a>
## 当前验证限制

校验器及拒绝测试在本地运行。对于 `0.0.1`，完整安装场景证据、Linux 安装包签名及模型安全凭据库证据仍是外部前置条件；Apple 公证和 Windows Authenticode 按本次重置版本要求无需配置。当前桌面发布工作流的构建及原生冒烟结果本身不能提供完整矩阵。发布任务要求存在 `release-assets/acceptance-manifest.json`，并在生成更新元数据或上传版本前，对标签提交与版本运行严格校验。缺失或不完整的证据会阻止发布。生成校验和后，`verify-release-assets.mjs` 会在上传前验证当前资产集合、`SHA256SUMS.txt` 中每个文件的字节，以及每份公开构建记录的源码树和组件清单。它会针对最终目录重新运行严格验收，并要求各通道指向准确的公开安装包，包括每一种桌面安装包；重新生成校验和不能授权替换安装包。最终资产集合为平铺目录，因此需要把经过审核的证据文件暂存到发布目录根部，并在清单中使用对应文件名。`test:update-manifest` 使用缺失及不完整的证据执行实际工作流 shell 步骤，验证其不能进入发布。当前构建任务不能收集完整 manifest；在提供经过独立审核的证据产物前，发布仍处于阻断状态。
