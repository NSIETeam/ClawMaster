# Agent Note: 桌面正式发布与更新确认

Status: implemented

[English](2026-09-13-desktop-stable-confirmed-updates.md) | 中文

## 问题

SemVer 将 `0.2.0-release` 视为预发行版本，但产品使用该名称表示正式版。启动更新若立即安装，可能打断未保存文档和运行任务。即使架构相同，Linux DEB 与 AppImage 安装也需要不同的更新文件。

## 决策

程序采用正式版本 `0.2.0`；Git 标签与发布标题可以追加仅供显示的 `-release` 后缀。[发布通道解析器](../../../../apps/desktop-tauri/scripts/release-channel.mjs)在发布前校验程序版本、Tauri 版本和标签。正式程序进入 GitHub Latest，且不能替换已有正式发布。预发行程序以预发布形式发布，不进入 Latest。

应用使用公开仓库的 HTTPS Latest manifest 和已有更新公钥。Release 启动在主窗口打开后检查，仅提示有可用版本。托盘操作先确认下载，再使用 Tauri 验签下载，最后单独确认安装与重启。任意一次拒绝均让当前应用继续运行。下载或验签失败不能进入安装。作用域守卫阻止并发更新操作，并在 future 取消时释放占用。Windows 安装在 Tauri 退出前停止 Host；其他平台通过桌面重启路径停止 Host。

manifest 包含签名的 `linux-x86_64-deb` 产物，并在 `linux-x86_64` 保留 AppImage。按安装器选择目标可避免把 AppImage 字节交给 DEB 安装器。本决策扩展[桌面壳 overlay](2026-08-14-desktop-shell-overlay-plugins.zh.md)的更新职责；[桌面 README](../../../../apps/desktop-tauri/README.zh.md#release)负责发行操作说明。

## 曾考虑的替代方案

**把产品显示名称用作程序版本。** SemVer 会将其排在正式版本之前，使用户要求的正式发布仍处于预发行通道。

**下载后立即安装。** 用户可能同意在工作期间下载更新。单独确认安装能让用户先保存内容并结束任务。

**Linux 只使用一个更新产物。** Tauri 在存在安装器专属目标时优先选择它；通用 AppImage 无法更新 DEB 安装。

## 后果

更新编排测试覆盖两次取消、验签失败、两次确认后安装及取消后的守卫释放。manifest 测试要求 DEB 签名和独立平台映射。发布仍要求完整平台矩阵与干净构建溯源。更新签名认证发行字节，不提供 Apple 公证或 Windows 发布者证书。确认安装前须保存编辑；更新器不检查文档草稿，也不负责完成运行任务。
