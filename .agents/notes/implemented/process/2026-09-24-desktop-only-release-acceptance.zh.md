# Agent Note: 正式发布验收仅覆盖桌面安装包

Status: implemented

[English](2026-09-24-desktop-only-release-acceptance.md) | 中文

## 问题

桌面发布工作流会构建 Windows、macOS 和 Linux 安装包，但没有 Android 安装包构建程序。在验收清单中强制要求 Android APK，会阻止每个桌面正式版本发布，并错误暗示此工作流会分发 Android 应用。

## 决策

桌面正式版要求 Apple Silicon macOS、Windows x64 NSIS、Linux x64 AppImage 和 Linux x64 DEB 的已安装验收。Beta 版本仍要求 Windows x64 NSIS 和 Apple Silicon macOS DMG 验收。Android 不属于此工作流，也不计为已交付或已验收的桌面安装包。只有在产品决定、Android 构建程序及其独立真机证据齐备后，Android 才能重新纳入发布范围。验收校验器要求每个桌面通道具备规定的操作系统发布者签名及安装证据。每项集成能力均按该版本声明的可用性检查：标为可用时，必须有已安装版本的成功使用证据；声明为不可用时，必须证明已安装应用会阻断操作并说明原因。

## 考虑过的替代方案

**在桌面矩阵中继续强制要求 Android。** 此工作流没有 Android 安装包构建程序，无法从自身构建产物生成完整清单；这也与本次将 Android 排除出发行范围的产品决定相冲突。

**把 Android 通道设为可选或 `not-run`。** 可选状态会模糊桌面发布实际包含的平台。桌面专属矩阵能够准确表示每个版本包含的安装器范围。

**要求每个版本都实际执行所有集成能力。** 这会与明确禁用某项能力的版本相冲突，例如 0.0.1 中未启用的 Native RPA。已安装应用必须证明该能力处于不可用状态，不能谎称执行成功，也不能因版本本来不提供的操作而失败。

## 后果

桌面发布不再等待 Android 产物或真机测试。macOS 公证、Windows Authenticode、Linux 安装包签名及真实安装验收仍是相应桌面通道的必需项。版本可在已安装应用证明操作会被阻断时，如实声明某项集成能力不可用；标为可用的能力仍需成功使用证据。将 Android 排除在此工作流之外，不代表 Android 产品已准备就绪。

## 验证

`release-acceptance.mjs` 和 `verify-release-assets.mjs` 为稳定版选择桌面安装包。相关测试会拒绝缺失的桌面通道，并确认稳定版清单没有 Android 通道。集成能力标为可用时必须成功使用；标为不可用时则需要阻断状态证据。[已安装版本验收说明](../../../../apps/desktop-tauri/acceptance/README.zh.md)定义必需观测。
