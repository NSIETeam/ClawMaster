# Agent Note: 原生桌面装饰与窗口重开

Status: implemented

[English](2026-09-13-clawmaster-native-window-titlebar.md) | 中文

## 问题

窗口内自绘顶栏重复平台控件与产品品牌，并需要独立处理几何布局和主题。macOS 窗口按保存的关闭偏好隐藏后，也必须能通过 Dock 与 Finder 重开，而不启动另一个 Host。

## 决策

主窗口使用原生装饰。macOS 选择 `TitleBarStyle::Overlay` 与 `hidden_title(true)`：交通灯保持原生，标题文字隐藏，不绘制独立顶栏。`titlebar_height()` 为零，内容 WebView 因此铺满窗口。平台负责窗口外观，嵌入的 DSH 客户端负责 Web 主题，两者可以不同。无需 `Theme::Dark`、私有 AppKit 遮罩及无边框专用 Tauri feature。

原生 macOS 控件与内容共用显示区域。内容引导脚本通过 `__DSH_DESKTOP_OVERLAY__` 提供 28 像素控件预留量，在 ClawMaster 图标识别的产品侧栏头部保留该空间。限定范围的观察器在侧栏重新挂载时恢复预留。其他平台不获得覆盖式顶栏指标。回环 Host 内容仅获得拖动与双击最大化权限；应用命令仍归本地外壳所有。

`shell.html` 负责使用系统配色的关闭确认对话框，打开时隐藏内容 WebView。保存的最小化偏好隐藏主窗口并保持 Host 运行；明确退出时停止 Host 进程树。macOS 的 `RunEvent::Reopen` 调用 `show_main`，显示、取消最小化并聚焦已有主窗口或启动窗口，不创建窗口、Host、Session 或 Workspace。已有 `ExitRequested` 阻止逻辑仍在用户请求退出前保留运行中的应用。

`window_layout.rs` 为本地外壳引导数据保留按钮布局解析，不预留标题栏高度。[ClawMaster 桌面壳决策](2026-09-12-clawmaster-shell-over-dsh.zh.md)负责产品身份、运行时与发布配置。

## 考虑过的替代方案

**保留可换主题的自绘顶栏。** 第二套控件实现必须独立追踪平台几何布局、颜色与交通灯行为。

**只隐藏产品图标。** 这仍保留重复顶栏，以及需单独维护的配色和控件。

**通过 AppKit 遮罩为透明无边框窗口加圆角。** 原生装饰已经负责系统圆角与阴影，私有遮罩会增加平台维护却不提供必要行为。

**在 macOS 重开应用时启动 Host。** 重开事件可能指向窗口隐藏的存活进程；另起 Host 会重复运行时所有权并争用同一份用户数据。

## 影响

原生装饰负责窗口几何布局与外观，`DSH_BG` 只作为首帧底色。原生窗口不保证跟随用户选择的 Web 主题。侧栏结构变化后，须在打包的 macOS 应用中检查交通灯预留与拖动区域。

Rust 布局与关闭偏好测试覆盖已有机械行为。打包桌面还需验收关闭隐藏后通过 Dock 或 Finder 重开、Host 身份保持、关闭对话框可见，以及两种系统外观下的原生控件。恢复自绘顶栏需要协调其标记、内容高度与权限，不是主题设置。
