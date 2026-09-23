# Agent Note: Beta 验收允许省略实时 IM 凭据

Status: implemented

[English](2026-09-23-beta-live-im-optional.md) | 中文

## Problem

Beta 版本的发布验收需要真实模型和桌面生命周期证据，但没有授权测试账号时无法安全读取微信、飞书、钉钉、QQ 或企微。

## Decision

Beta 清单允许将选定聊天微信读取和五个 IM 界面集成标记为 `not-run`，并要求填写主动省略实时连接器凭据的原因。模型、Office、Native RPA、生命周期、升级、网络恢复、审批、回滚和写入安全检查仍然必须通过。

## Consequences

这只影响 beta 验收政策；稳定版本仍要求完整的 IM 阻断或连接证据。实时连接器不会因为该政策获得任何账号授权。

## Verification

`release-acceptance.test.mjs` 覆盖 beta 可省略和稳定版本仍需完整集成的行为。
