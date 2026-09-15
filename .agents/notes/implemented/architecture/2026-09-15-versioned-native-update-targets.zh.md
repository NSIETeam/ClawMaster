# Agent Note: 更新目标要求变化时分离原生更新通道

Status: implemented

[English](2026-09-15-versioned-native-update-targets.md) | 中文

## 问题

桌面发布移除 Intel Mac 后，更新 manifest 从五个目标变为四个。已安装的更新组件 0.1.0 和 0.1.1 要求全部五项；将其现有端点响应替换成四目标会导致校验失败。服务器响应不能替换这些客户端已加载的解析器。

## 决策

[manifest 生成器](../../../../apps/desktop-tauri/scripts/generate-updater-manifest.mjs)选择 `current` 或 `legacy`。当前发布要求 Windows x64、macOS arm64、Linux x64 AppImage 与 Linux x64 DEB。旧 manifest 额外包含 Intel macOS。生成时要求显式选择 CLI 参数；读取时只接受这两种完整集合。文件缺失不代表允许不完整发布，未知目标会被拒绝。

v2 通道使用 `/updates/clawmaster/v2/latest.json` 和 `/updates/clawmaster/v2/versions/`，具有独立服务代码与可写状态。旧根 manifest 保持五目标的 0.2.1 响应，其不可变文件继续可用。组件目录与便携更新包保留现有根路径。两个原生通道保留同一固定发布公钥及[已验证字节的发布规则](2026-09-15-desktop-self-hosted-update-channel.zh.md)。

同步器要求选定的 GitHub 产物集合与 manifest 目标集合一致。旧 Intel 产物必须具有对应签名和 manifest 条目；当前发布同时省略二者。两种集合都执行相同的校验和、签名、版本及原子发布校验。[服务器参考](../../../../apps/desktop-tauri/server-updates/README.zh.md)负责迁移、保留状态检查与回滚。

## 考虑过的替代方案

**原地替换旧端点。** 严格的已安装解析器正在使用该 URL；源码变化不能让这些客户端接受新响应。

**按照缺失文件推断任意可用目标。** 这可能发布缺少必需 Windows、Apple Silicon 或 Linux 产物的版本。两种显式完整集合保留了必须执行的平台检查。

**将旧 Intel 安装包改成新版本文件名复用。** 签名有效不代表包内应用版本与另一发布版本相符。保留旧通道才能保留真实的版本身份。

## 影响

旧组件在显式更新前继续使用保留通道；单独迁移服务器不会将其切换到 v2。服务器保留两个目录，并检查迁移后所有旧文件哈希未变。原生安装验收仍针对三个受支持的构建目标分别执行。

测试使用真实 Minisign 向量验证新旧产物，拒绝缺失或未知目标及不完整的 Intel 条目，并验证发布或拒绝 v2 候选版本都不能修改独立的旧状态。这些检查不代表已经完成服务器部署或客户端升级。
