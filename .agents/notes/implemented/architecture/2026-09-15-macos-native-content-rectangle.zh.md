# Agent Note: macOS 控件位于内容 WebView 之外

Status: implemented

[English](2026-09-15-macos-native-content-rectangle.md) | 中文

## 问题

全窗口大小的 macOS 内容视图会让原生交通灯覆盖会话、侧栏或插件最上方的控件。给 ClawMaster 图标定位到的头部增加空白，无法保护其他插件布局或重新挂载的头部。原生窗口几何布局需要独立于嵌入页面的统一负责人。

## 决策

[原生外壳](../../../../apps/desktop-tauri/src-tauri/src/chrome.rs)选择 `TitleBarStyle::Transparent` 和 `hidden_title(true)`。在锁定的 Tauri 运行时中，这会关闭全窗口内容视图，在窗口内容矩形上方保留原生标题栏区域。子 WebView 填满该内容矩形；外壳不增加人为标题栏偏移。因此原生控件和插件内容分别占用不同区域，无须识别插件 DOM 元素、观察其挂载或注入覆盖式顶栏指标。

macOS 提供窗口背景和标题栏外观，外壳不将该区域固定为暗色。嵌入客户端保留单独选择的 Web 主题。本决策仅替代[原生窗口决策](../feature/2026-09-13-clawmaster-native-window-titlebar.zh.md)中的覆盖式顶栏预留方案；原记录继续负责原生装饰、关闭处理及重开已有 Host。

## 考虑过的替代方案

**保留覆盖模式，在每个插件头部预留空间。** 这可以保持紧凑的标题区域，却依赖每个插件的标记、挂载生命周期及最上方控件。仅在侧栏预留空间仍会暴露其他页面。

**选择 `TitleBarStyle::Visible`。** 锁定的 `tauri-runtime-wry` 2.11.4 对 `Visible` 和 `Overlay` 都启用全窗口内容视图。选项名称不能证明原生控件位于 WebView 之外。

## 影响

原生标题栏占用垂直空间，其外观可以与用户选择的 Web 主题不同。这一成本避免逐插件适配布局，并让平台负责窗口控件、拖动、缩放和外观。

打包的 macOS 发布验收要求测量原生交通灯与内容 WebView 在屏幕坐标系中的矩形，并确认它们不重叠。缺失或含糊的几何信息不能视为成功。仅有源码选项、DOM 字符串及合成布局测试，不能证明已安装窗口的实际布局。[原生验收脚本](../../../../apps/desktop-tauri/scripts/verify-macos-native.mjs)负责可执行检查；[验收决策](../testing/2026-09-15-macos-native-relaunch-acceptance.zh.md)继续限定平台与生命周期证据范围。
