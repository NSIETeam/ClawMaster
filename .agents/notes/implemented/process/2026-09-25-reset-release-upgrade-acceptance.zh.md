# Agent Note: Reset release 0.0.1 acceptance

Status: implemented

[English](2026-09-25-reset-release-upgrade-acceptance.md) | 中文

## Problem

重置版无法使用 Apple Developer ID 或 Windows Authenticode 凭据，且不支持从已撤回的 0.2.x 版本自动升级。

## Decision

验收仅允许精确版本 `0.0.1` 将 macOS 记录为 `ad-hoc-unnotarized`，将 Windows 记录为 `unsigned`，并要求保留签名状态证据、在 `signature.reason` 中明确说明限制。Linux AppImage 和 DEB 签名仍为必需项。首次启动教程说明校验和验证及操作系统警告处理步骤。之后的每个稳定版仍要求现有的 macOS 公证和 Windows Authenticode。`0.0.1` 清单可以不声明升级来源，用户必须手动安装。

## Alternatives considered

**要求 0.0.1 使用 Apple 和 Windows 签名：**凭据不可用，且用户明确选择不使用这两种签名；这会阻止所要求的重置版发布。

**所有稳定版都接受未签名产物：**这会取消未来版本的发布者身份校验。因此例外仅由精确版本 `0.0.1` 触发。

**删除所有签名检查：**Linux 更新负载签名保护另一条交付路径，因此继续保留。

## Consequences

重置版没有 Apple 公证或 Windows 发布者身份，因此首次启动可能显示平台安全警告。校验和验证与关联教程帮助用户核对下载字节并谨慎继续。此例外不会削弱后续稳定版策略。

## Verification

验收测试证明 `0.0.1` 仅接受有明确记录的 macOS 临时签名和 Windows 未签名状态，后续稳定版仍要求原有签名类型。Linux 通道仍在 `0.0.1` 矩阵中，并要求 Minisign 证据。
