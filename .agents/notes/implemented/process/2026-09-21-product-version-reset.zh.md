# Agent Note: 产品版本重置为 0.0.1beta

Status: implemented

[English](2026-09-21-product-version-reset.md) | 中文

## 问题

产品此前有两条回答不同问题的版本线：桌面外壳继承自历史桌面发布线的 `0.2.3-fix`，以及服务端 `appVersion` RPC 硬编码、与任何版本都对不上的 `0.0.2beta`（缺陷登记 D8）。在本仓库成为 ClawMaster 唯一产品仓库后，产品决定把对外版本重置为 `0.0.1beta`，作为全新的版本起点。

## 决策

产品对外版本为 `0.0.1beta`。机器可读字段使用合法的 semver 预发布形式 `0.0.1-beta`：[apps/desktop-tauri/package.json](../../../../apps/desktop-tauri/package.json)、[tauri.conf.json](../../../../apps/desktop-tauri/src-tauri/tauri.conf.json) 以及 [Cargo.toml](../../../../apps/desktop-tauri/src-tauri/Cargo.toml) 中的桌面 crate 及其锁文件条目。用户可见字符串保留字面形式：服务端 `appVersion` 与 `updateCheck` RPC 返回 `0.0.1beta`，README/STATUS/DEFECTS 的基线声明写明重置及其日期。

DSH workspace 包版本线保持 `0.1.5-rc.2` 不变。该版本线标识的是 harness 运行时供给（`harness-versions/72da6c767414dd30`）与精确互依的包依赖图；改名会切断与已部署、自恢复运行时的版本对应，且产品侧看不到任何变化。

## 备选方案

**把全部 workspace 包也重置为 `0.0.1-beta`。** 要动八十多个 manifest、其中的精确 peerDependencies、锁文件和断言精确版本号的测试，还会切断与已部署运行时供给的版本对应。

**在 tauri.conf.json 和 package.json 里直接写 `0.0.1beta`。** 该字符串不是合法 semver，Tauri 构建会拒绝，更新器比较也要求 semver。带连字符的形式是给机器用的。

**删除历史发布标签（`v1.8.x`、`desktop-v0.2.3`）。** 已发布的版本是历史事实；重置是给产品重新编号，不是改写发布历史。

## 后果

已安装的 `0.2.3` 客户端会把 `0.0.1-beta` 版本视为降级，更新器不会推送；重置面向全新安装和下一次发布重新起号，不是就地升级路径。`appVersion` 表面重新与桌面产品版本一致，D8 漂移登记项就此解决；结构性根治——从 package.json 注入版本而非硬编码——仍是登记的方向。
