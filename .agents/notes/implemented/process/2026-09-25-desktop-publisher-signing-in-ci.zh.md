# Agent Note: CI 中的桌面发布者签名

Status: implemented

[English](2026-09-25-desktop-publisher-signing-in-ci.md) | 中文

## Problem

由于工作流既未导入发布者证书，也未提供 Apple 公证凭据，桌面 CI 只能产出未签名或临时签名包。严格的稳定版验收检查器已经要求 macOS 使用 Developer ID 公证、Windows 使用 Authenticode，因此运维人员无法通过现有构建流程满足这些检查。

## Decision

macOS CI 接受完整的 Developer ID、App Store Connect API 密钥和 Team ID 配置，将私有 `.p8` 密钥写入运行器临时目录，并验证生成应用的签名、Team ID、已钉附票据及 Gatekeeper 评估结果。Windows CI 仅在配置预期指纹时导入带密码保护的 PFX，通过临时配置覆盖文件将该指纹传给 Tauri，然后使用 Authenticode 验证每个生成的可执行文件。部分签名配置会在打包前失败。缺少凭据时会产生明确标记的未签名候选构建；严格稳定版发布门槛保持不变，并拒绝未签名的验收证据。

## Alternatives considered

允许未签名稳定版发布会违背验收检查器中的发布者身份要求。缺少凭据时拒绝所有候选构建，则会妨碍运行时和打包变更的其他测试。因此，工作流允许明确标记为仅用于构建的候选包，但发布仍要求完整的发布者证据。

## Consequences

仓库运维人员必须在稳定版发布前配置 Apple Developer ID 和 App Store Connect 密钥，以及 Windows 代码签名密钥和固定证书指纹。构建签名检查证明产物签名和公证状态，但不能代替干净安装场景、升级、模型使用、集成测试或留存验收证据。
