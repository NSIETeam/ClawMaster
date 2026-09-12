# Agent Note: 基于 DSH 的 ClawMaster 桌面壳

Status: implemented

[English](2026-09-12-clawmaster-shell-over-dsh.md) | 中文

## 问题

ClawMaster 需要直接使用成熟的 DSH 运行时、会话、审批、工具与插件生态，避免维护第二套 Agent 后台。产品仍需使用 Tauri 桌面壳、ClawMaster 视觉身份，并通过二维码接入企业 IM。若原样交付上游桌面，启动页、窗口顶部、通知与 Web 界面会显示 DeepSeek Harness。

## 决策

ClawMaster 只负责产品呈现与 Tauri 桌面壳。运行执行、会话、工具、审批、存储和插件加载由 DSH 负责。`@clawmaster/dsh-frontend` 通过公开客户端插槽作为外置 DSH Web profile 插件安装，增加 ClawMaster 图标、WatchDog 导航与工作台，以及口号“开启AI时代的企业协作”。其 Host 会在 `$DSH_HOME/watchdog-workspaces/managed` 创建系统托管的 Workspace；每个新 WatchDog 会话都明确绑定该空间，不继承用户当前或最近工作空间。同一 bundle 启用 DSH 官方 Schedule 与 time-context；DSH base 已默认提供 Goal 与 goal-round-driver。`@xmanrui/dsh-im` 在同一 DSH profile 中提供飞书、微信、企微与钉钉扫码接入。

默认 profile 还挂载 `dsh-better-sidebar@0.19.1`。该版本由维护者按 DSH 0.1.5-rc.2 验证，提供原生右侧栏、CodeMirror 编辑器、文件预览、沙箱多标签网页浏览器、终端、Git 和任务视图。ClawMaster 在 WatchDog 工作台增加可直接使用的本机数据处理、CRM 与 ERP 组件。当前 CRM 和 ERP 记录使用浏览器本地存储，是可用的桌面组件，不是多人企业数据库。

所有用户可见的原生字符串与资源均使用 ClawMaster，包括应用元数据、启动页、浏览器文档标题、托盘、通知、关闭对话框、Windows 快捷方式与安装器图标。自定义窗口顶栏只保留拖拽区域和窗口控件，不再重复显示产品图标或名称。内部 `dsh` 命令、包名、profile 数据和旧应用数据路径继续作为兼容合同保留。

DSH 提供品牌图标插槽，但没有对话首页标题插槽。因此 ClawMaster 图标把 `MutationObserver` 限定在 `[data-phase="hero"]`，只替换完全匹配的上游中英文标题。这样无需修改 DSH 源码，但上游文字或结构变化后必须进行可见界面回归。

## 考虑过的替代方案

**保留原 ClawMaster 运行时。** 这能保留完整控制权，却会重复开发 DSH 已有的会话、工具、审批与插件能力，不符合减少维护的目标。

**原样交付 DSH 桌面。** 代码最少，但应用会在启动和正常使用期间显示 DeepSeek Harness 身份。

**分叉 DSH Web 客户端。** 这样能直接替换所有文字，却会产生第二套 Web 界面，使上游升级变成持续合并工作。

## 影响

ClawMaster 不代理或重写插件协议，因此插件兼容性跟随实际 DSH profile。兼容仍取决于各插件声明的 DSH 版本，并需运行时验证。已审计的社区插件 `dsh-stall-guard@1.3.0` 不作为默认项：它使用过时的 `agent/status` 监听参数，并在写入 `user/message` 时缺少 DSH 0.1.5-rc.2 要求的 surface intent。`dsh-univer-office@0.2.14` 也未接入，因为它只声明 DSH 0.1.1-rc.2 或 0.1.2-rc.1 peer，不覆盖当前 0.1.5-rc.2 运行时。官方 Goal 与 Schedule 构成已接受的续跑与定时 follow-up 基线。企业 IM 凭据保留在插件与 DSH 主目录，ClawMaster 不把它们复制到普通配置。四个平台只有在二维码正确渲染且操作员完成扫码后才算真实连接。每次桌面发布都必须检查启动页、标题栏、对话首页、设置页和通知中是否残留上游品牌。
