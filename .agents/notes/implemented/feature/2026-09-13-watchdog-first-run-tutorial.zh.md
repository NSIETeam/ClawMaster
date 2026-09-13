# Agent Note: WatchDog 首次使用教程

Status: implemented

[English](2026-09-13-watchdog-first-run-tutorial.md) | 中文

## Problem

首次进入必须教授企业管理：范围、分工、业务依据、重复巡检和整改。确认记录必须在桌面端口变化后保留，且不能暗示模型或 IM 已验证就绪。

## Decision

[WatchDog 前端](../../../../frontends/dsh/README.zh.md#first-run-tutorial)围绕本周客户跟进与交付风险提供五步教程。用户确定范围、写清分工与验收标准、核查 CRM/ERP 和提供的文件、选择频率并复核审批，再验证结论、要求整改。分工是任务说明中的文字；交付承诺需要提供依据。教程不宣称存在人员分配看板或结构化交付跟踪。

DSH 既有的 `settings.onboarding` 协调器等待设置、Session 和工作空间读取完成，且要求用户没有历史。设置中提供重看。ClawMaster 省略模型插件的两个自动欢迎步骤，但保留提供方编辑器；官方构建保留既有顺序。显式跳过和完成会在 `clawmaster-watchdog-onboarding` 的 `acknowledgedVersion` 写入版本 1；较新版本仍视为已确认。设置服务负责持久化、冲突与恢复。写入未确认时保持教程打开以供重试。远程内存模式仅在协调器本次存续期间保留确认。

主按钮通过公开布局 API 选中 WatchDog。模型与 IM 辅助按钮位于其后，使用 `openSection`。阅读和导航不会创建 Session、提交提示词、启动提醒或发送外部消息。重复巡检需要应用与 Session 保持活动；任务未运行不代表任务已完成。

[ClawMaster 外壳决策](2026-09-12-clawmaster-shell-over-dsh.zh.md)单独负责运行环境复用、延迟分配工作空间与企业组件。

## Alternatives considered

**浏览器 localStorage。** 确认依赖临时来源，且不提供共享版本处理。

**独立后端或自动演示。** 前者重复设置能力，后者在用户提交工作前消耗模型额度。

**重复的欢迎顺序。** 它们打断首次任务；模型配置已有显式入口。

## Consequences

完成只记录教程已关闭。编译客户端验收记录两种语言，覆盖新老用户、写入拒绝、重看、持久化期间卸载，以及进入管理台而不创建任务。原生桌面验收负责 WebKit 焦点、响应式布局与真实重启后的确认保留。
