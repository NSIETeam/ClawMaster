# Agent Note: Beta 版接受 ad-hoc 签名并仅发布 macOS 通道

Status: implemented

[English](2026-09-23-beta-signature-policy.md) | 中文

## 问题

安装验收门禁要求每个通道提供操作系统级签名验证证据：macOS DMG 要求 `developer-id-notarized`，Windows NSIS 要求 `authenticode`。这两类凭证不存在（BLOCKERS.md 中的 GitHub #251 与 #247 即采购项），因此构建已全部通过的 `desktop-v0.0.1-beta.*` 列车（含真实浏览器首启渲染门禁）完全无法发布。产品管理已于 2026-09-23 显式确认放宽门禁。

## 决策

对 beta 版本（`<semver>-beta.N`），`BETA_ACCEPTANCE_TARGETS` 收窄为 `macos-arm64-dmg` 通道，并接受 `signature.kind = 'unsigned-ad-hoc'`，以 codesign 验证输出作为该通道的签名证据。Windows 通道在 Authenticode 凭证与真实验收设备到位后恢复。稳定版矩阵一字未动：仍然强制发行商公证与 Authenticode，"ad-hoc 不能替代发行商验证"的既有测试对稳定版本依旧通过。新增测试钉住 beta 行为：收窄后的 macOS 模板可验证通过、Windows 通道无法混入 beta 清单、稳定矩阵拒绝 ad-hoc 签名。

## 备选方案

**等证书到位后再发布任何 beta。** 交由产品管理决策；已确认的决策是先发布 beta，稳定版维持严格政策。

**beta 同时豁免逐场景证据。** 否决：macOS 通道仍在真机上收集真实的逐场景证据，放宽的只有签名种类，门禁继续验证当前凭证所能覆盖的一切。

**只放宽 Windows 通道的签名要求。** 否决：没有真实 Windows 验收设备，该通道无法诚实执行，整体延后优于记录编造的结果。

## 后果

macOS 通道的真实验收证据落到证据分支后，`desktop-v0.0.1-beta.*` 即可发布；Windows 安装包仍会出现在候选产物中，在 #247/#251 关闭前必须标注"未签名、未验收"。beta 用户首次启动会看到 Gatekeeper 告警。证书到位后，回退本政策只需两行改动，稳定版矩阵从未移动。
