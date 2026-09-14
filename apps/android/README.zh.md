---
description: 独立安卓 Agent、手机本地数据、审批规则与 APK 验证。
---

# ClawMaster 安卓版

[English](README.md) | 中文

## 概述

ClawMaster 安卓版在手机上运行原生 Java Agent 循环。它直接调用用户配置的、兼容 Chat Completions 的 HTTPS 模型，不连接电脑上的 ClawMaster Host。系统要求为 Android 8.0 或以上。

## 目录

- [使用](#use)
- [数据与权限](#data-and-permissions)
- [开发](#development)
- [分发](#distribution)

<a id="use"></a>
## 使用

打开设置，输入模型 API 基础地址、模型 ID 和 API 密钥后保存。基础地址不包含 `/chat/completions`。消息和按需读取的笔记内容会发送到所配置的服务商，因此需要网络连接及服务商额度。

Agent 可以搜索、读取手机本地笔记并提出写入建议。Agent 的每次写入都会打开原生审批对话框。更新已有笔记必须带上读取时的修订号；等待审批期间发生的修改会导致冲突。手动编辑笔记也使用相同的修订检查。

历史会话和笔记会跨重启保存。应用离开前台时任务停止，Activity 重建除外。工具中断且没有持久化回执时，其结果视为未知，不会自动重试。

这个移动运行时不包含桌面 DSH 插件系统、终端、电脑控制 RPA、浏览器自动化、后台定时任务、Graph Memory、CRM/ERP 或跨设备同步。它不是离线端侧语言模型。

<a id="data-and-permissions"></a>
## 数据与权限

应用仅请求联网权限。笔记与带版本的 JSON 会话记录保存在应用私有存储中。模型密钥使用 Android Keystore 与 AES-GCM 加密，不写入模型记录、日志或 APK 资源。明文模型地址及包含凭据的 URL 会被拒绝；授权头不会跟随重定向发送。

移除 API 密钥不会删除笔记和会话。卸载应用会删除本地数据；云备份与设备迁移均被禁用。卸载前请另行保存需要保留的内容。Agent 不能读取任意共享存储或执行 shell。

<a id="development"></a>
## 开发

使用 JDK 17、Gradle 8.13、Android SDK 36 和 Build Tools 35.0.0。安卓工程独立于桌面 pnpm 构建。

```sh
gradle -p apps/android :core:test :app:lintRelease :app:assembleRelease
```

核心测试使用记录的模型交互，执行随应用交付的循环与文件存储。设备测试执行发布版代码、原生审批、Activity 重建及 Keystore 操作。验证流水线保留已安装 APK，强制结束进程后检查常规启动导航，再在独立进程运行 `ColdStartCheck`，读取上一轮保存的笔记与工具回执。记录型模型证明本地执行链路，不代表真实服务商可用。

要签名并测试 release 变体，设置 `ANDROID_KEYSTORE_PATH` 和 `ANDROID_KEYSTORE_PASSWORD`，密钥别名为 `clawmaster`。随后运行 `gradle -p apps/android :app:connectedReleaseAndroidTest`。不得提交密钥库或密码。

<a id="distribution"></a>
## 分发

安卓验证流水线构建不可调试的 APK 并运行模拟器检查。其临时签名证书仅用于验证。对外分发需要用妥善保留的发布密钥签名已验证 APK，运行 Android 的 `apksigner verify` 检查，并记录 SHA-256 和证书指纹。更新必须使用相同发布密钥和更高的版本代码。

生成 APK 不等于完成 Google Play 发布或 Android 开发者账户验证。[独立运行时决策](../../.agents/notes/implemented/architecture/2026-09-14-android-standalone-agent.zh.md) 解释了它与桌面运行时的分离。
