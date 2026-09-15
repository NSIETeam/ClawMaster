# Agent Note: macOS 原生再次启动验收

Status: implemented

[English](2026-09-15-macos-native-relaunch-acceptance.md) | 中文

## 问题

安装包签名及直接启动 Host 不能证明交付的 macOS 应用能够打开主窗口、关闭 Host，或在保留数据的情况下再次启动。通过信号终止进程不能证明正常窗口关闭流程可用。

## 决策

[原生验收脚本](../../../../apps/desktop-tauri/scripts/verify-macos-native.mjs)将构建后的应用复制到包含空格及 Unicode 的随机 runner 目录。它拒绝已有桌面安装、进程及 Harness 主目录，仅创建自身拥有的应用数据和独立 DSH 主目录。每次启动必须发布新的运行时记录，与桌面 PID、子 Host、打包摘要及干净发布来源一致。准备、打包及运行中的清单必须匹配。设置文件和会话目录内的标记文件在两次启动前后必须保持字节不变。

GUI 模式使用系统 `osascript` 检查所属 PID，并点击主窗口的关闭按钮。[GitHub 镜像配置](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-tccdb-macos.sh)为该可执行文件预先授予辅助功能及 System Events 权限。前置检查核对实际权限和 GUI 可用性，不申请授权或修改 TCC。缺少权限意味着 GUI 检查失败。正常关闭要求退出码为零、没有终止信号、同一运行记录标为停止且 Host 已退出。失败后的清理只针对已观测归属的进程，包括预置阶段子进程。

显式终止模式将 SIGTERM 记录为进程终止，允许另行记录 Host 清理，并报告 `guiCloseVerified: false`。它不会自动替代失败的 GUI 检查。[准备源码决策](2026-09-14-desktop-compatibility-source-binding.zh.md)继续负责依赖及产物兼容性检查。

## 考虑过的替代方案

**将 Host 就绪当作原生验收。** HTTP 监听正常时，应用窗口或关闭处理仍可能失效。

**在测试中授予 TCC 权限。** 修改机器权限数据库会把 runner 前提条件变成安全策略修改。

**SIGTERM 成功即通过。** 进程终止能够提供再次启动的证据，但没有执行产品的正常关闭处理。

## 影响

脚本仅限一次性 GitHub 托管 macOS runner。单元测试验证不合格证据被拒绝，以及可执行入口拒绝本机运行，全程不启动 ClawMaster。GUI 验收要求在所选镜像上运行成功；源码检查和单元测试不能提供这一结果。哨兵验证文件保留，不验证模型会话回放。DMG 拖拽安装、Gatekeeper/公证、真实账号及外部模型操作需要单独验收。

macOS 进程观测使用英文 UTF-8 locale，在保留 Unicode 可执行文件路径的同时保证创建时间可解析。临时的非 GUI 可执行程序验证包含中文、空格和井号的路径；这项检查不启动桌面应用，只提供进程身份验证证据。
