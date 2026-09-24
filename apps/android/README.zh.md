---
description: 独立安卓 Agent、手机本地数据、审批规则与 APK 验证。
---

# ClawMaster 安卓版

[English](README.md) | 中文

## 概述

本次重置版为 Android 0.0.1。它使用新的 Android 发布证书；从 0.2.x 安装时必须先卸载旧版，卸载会删除应用私有数据。需要保留的笔记、文档与会话请先导出。

ClawMaster 安卓版在手机上运行原生 Java Agent 循环。它直接调用用户配置的、兼容 Chat Completions 的 HTTPS 模型，不连接电脑上的 ClawMaster Host。系统要求为 Android 8.0 或以上。

## 目录

- [使用](#use)
- [数据与权限](#data-and-permissions)
- [开发](#development)
- [分发](#distribution)

<a id="use"></a>
## 使用

打开设置，输入模型 API 基础地址、模型 ID 和 API 密钥后保存。基础地址不包含 `/chat/completions`。消息和按需读取的笔记、文档内容会发送到所配置的服务商，因此需要网络连接及服务商额度。

Agent 可以搜索、读取手机本地笔记并提出写入建议。Agent 的每次写入都会打开原生审批对话框。更新已有笔记必须带上读取时的修订号；等待审批期间发生的修改会导致冲突。手动编辑笔记也使用相同的修订检查。

历史会话、笔记和待审批写入会跨重启保存。用户发起的任务使用可见的前台服务，离开界面后可以继续运行。每次运行最多八分钟，安卓停止服务或任务时也会终止。工具中断且没有持久化回执时，其结果视为未知，不会自动重试。

### 文档

在文件页导入 DOCX、XLSX、PPTX、TXT、Markdown 或 CSV 的私有副本，最大 8 MiB。让 agent 检查文档或提出修改，核对准确参数和修订后批准或拒绝。文件列表提供文字预览，并可通过系统文档选择器明确导出。导入原件和旧修订保留在私有存储中；agent 不覆盖外部源文件。

Office 工具读取 Word 正文段落及顶层表格、已有电子表格单元格，以及幻灯片顶层文本形状。编辑会替换指定文字，文字内部的混合格式可能合并。表格替换内容是字面字符串，不是公式。新建文件接受段落、制表符分隔的单元格，或换页符分隔的幻灯片。不支持复杂排版、页眉、绘图、嵌入对象、公式计算、宏及数字签名文档。

### 任务

在任务页填写提示词、开始延迟，以及可选的重复间隔（至少 15 分钟）。Android JobScheduler 持久化任务并要求网络；省电限制、强制停止和系统额度可能延迟或终止执行。定时任务可能产生模型费用，但不预先授权任何写入。在设置中开启任务通知，以接收完成或审批提示。

写入会暂停执行并持久化建议。打开对应会话进行复核，只授权这份建议，并再次核对当前修订。成功的重复任务会安排下一次；失败、停止和中断的任务不会。选择重新运行前先检查已有结果，因为部分写入可能已经完成。停止会取消所选定时任务，任务记录仍然保留。

这个移动运行时不包含桌面 DSH 插件系统、终端、电脑控制 RPA、浏览器自动化、Graph Memory、CRM/ERP 或跨设备同步。它不是离线端侧语言模型。

<a id="data-and-permissions"></a>
## 数据与权限

应用声明联网及网络状态、前台服务、任务通知和重启持久化权限。共享文件通过系统选择器选择，不申请广泛存储访问权限。笔记、文档、任务记录和带版本的 JSON 会话保存在应用私有存储中。模型密钥使用 Android Keystore 与 AES-GCM 加密，不写入模型记录、日志或 APK 资源。明文模型地址及包含凭据的 URL 会被拒绝；授权头不会跟随重定向发送。

移除 API 密钥不会删除笔记和会话。卸载应用会删除本地数据；云备份与设备迁移均被禁用。卸载前请另行保存需要保留的内容。Agent 不能读取任意共享存储或执行 shell。

<a id="development"></a>
## 开发

使用 JDK 17、Gradle 8.13、Android SDK 36 和 Build Tools 35.0.0。安卓工程独立于桌面 pnpm 构建。

```sh
gradle -p apps/android :core:test :app:lintRelease :app:assembleRelease
```

核心测试使用记录的模型交互，执行随应用交付的循环与文件存储，包括 Office 往返读写、修订冲突、持久化审批和任务恢复。设备测试执行发布版代码、原生审批、Activity 重建、Keystore 操作、Office 容器、切到后台继续运行及系统定时执行。流水线在 API 26 与 API 36 模拟器中安装正式签名的候选 APK，运行 Agent、Office、审批和后台任务测试；随后强制结束应用，检查常规启动导航，再在独立进程运行 `ColdStartCheck`，读取上一轮保存的笔记与工具回执。记录型模型证明本地执行链路，不代表真实服务商可用。

要签名并测试 release 变体，设置 `ANDROID_KEYSTORE_PATH` 和 `ANDROID_KEYSTORE_PASSWORD`，密钥别名为 `clawmaster`。随后运行 `gradle -p apps/android :app:connectedReleaseAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=team.nsi.clawmaster.android.StandaloneAgentTest,team.nsi.clawmaster.android.WorkspaceAgentTest`。升级与冷启动检查需要按流水线顺序准备。不得提交密钥库或密码。

<a id="distribution"></a>
## 分发

安卓验证流水线构建不可调试的 APK 并运行模拟器检查。其临时签名证书仅用于验证。对外分发需要用妥善保留的发布密钥签名已验证 APK，运行 Android 的 `apksigner verify` 检查，并记录 SHA-256 和证书指纹。更新必须使用相同发布密钥和更高的版本代码。

生成 APK 不等于完成 Google Play 发布或 Android 开发者账户验证。[独立运行时决策](../../.agents/notes/implemented/architecture/2026-09-14-android-standalone-agent.zh.md) 负责与桌面的分离，[文档与任务决策](../../.agents/notes/implemented/architecture/2026-09-15-android-document-tasks.zh.md) 负责 Office 兼容与审批恢复。Office 构建会下载校验和固定的兼容源码及 Maven 依赖；许可证保留在重定位运行时中。
