# Agent Note: 独立安卓 Agent

Status: implemented

[English](2026-09-14-android-standalone-agent.md) | 中文

## Problem

安卓应用必须独立于电脑或托管的 ClawMaster 进程执行 Agent。桌面安装包内嵌 Node Host 以及平台专属的子进程、托盘和文件系统集成，因此修改打包目标并不能得到受支持的安卓运行时。

## Decision

[安卓应用](../../../../apps/android/README.zh.md) 拥有原生 Java 循环、直连 HTTPS 模型传输、应用私有笔记及带版本的会话记录。其数据格式与已发布的 DSH Session 世代分离。应用既不导入这些世代，也不宣称兼容桌面插件。

移动执行器将工具执行限制在声明的手机本地能力内。每次模型发起的写入都需要原生审批，审批绑定准确的提议值。取消与提交串行执行；取消不能授权尚未提交的写入。中断后缺少持久化工具回执表示结果未知，不表示应当重试。[文档与任务决策](2026-09-15-android-document-tasks.zh.md) 负责 Office 工具和持久化审批。

服务商凭据使用 Android Keystore 加密。模型 URL 必须使用 HTTPS，且不包含用户信息、查询参数或片段。请求不会携带授权头跟随重定向。APK 没有共享存储、shell 或无障碍控制权限。

## Alternatives considered

远程 WebView 客户端体积更小，但依赖电脑或服务器，不满足独立运行要求。嵌入桌面 Node 运行时能够复用更多源码，却无法解决原生依赖与 Android 进程限制的支持问题。完整桌面能力对齐仍是独立的产品决策；不可用工具同时从执行路径和模型可见 schema 中排除。

## Consequences

手机可以在没有 ClawMaster 后端的情况下完成模型、工具和审批循环，但仍需配置模型服务商并保持联网。[文档与任务决策](2026-09-15-android-document-tasks.zh.md) 以安卓管理的执行和明确的恢复规则取代仅限前台的限制。移动记录与凭据保存在应用私有空间，卸载时删除。

核心记录型模型测试覆盖审批拒绝、参数篡改、修订冲突、取消、未知工具和中断记录。Release 变体设备测试覆盖原生审批、Activity 重建、本地持久化和 Keystore 往返读写。APK 及证书验证与真实模型或应用市场验收仍然分开。
