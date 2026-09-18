# Agent Note: ClawMaster 原生权限归属于包内 WebView

Status: implemented

[English](2026-09-16-clawmaster-native-privilege-isolation.md) | 中文

## Problem

桌面窗口同时包含包内外壳与独立的已认证 Host WebView。按窗口授权会包括子 WebView，而 localhost 通配符也匹配其他监听器。文档内容不能通过任一规则继承原生命令。

## Decision

[Capability](../../../../apps/desktop-tauri/src-tauri/capabilities/default.json) 仅匹配包内 `main` WebView，授予窗口拖动权限，以及由应用构建 manifest 注册并交给 Tauri ACL 强制执行的三个外壳命令。`splash` WebView、Host 内容及预览 frame 不获得原生权限。[导航校验器](../../../../apps/desktop-tauri/src-tauri/src/webview_security.rs)要求带明确端口的数字回环 HTTP 地址，并将主 Host 视图限制在同一精确来源。要求新浏览上下文且不含内嵌凭据的 HTTP(S) 引用通过默认浏览器打开；回环监听器与可执行协议被拒绝。只有不带查询参数的同源 Office 许可说明精确路径可创建独立的已认证文档视图。其标签不匹配任何原生 capability，导航仍限于许可说明路径。

[包内页面 CSP](../../../../apps/desktop-tauri/src-tauri/tauri.conf.json) 默认拒绝资源，仅允许同源脚本、样式与图片，连接限于 Tauri IPC。外壳和启动页加载本地脚本及样式表文件；策略不授予 `unsafe-inline` 或 `unsafe-eval`。frame、对象嵌入、表单提交与基础 URL 覆盖均被拒绝。该策略不能替代独立 Host 的网页资源策略或 DSH 工具权限。[运行治理决策](2026-09-13-clawmaster-runtime-governance.zh.md)继续负责执行策略；插件仍是具有 Host 进程权限的可信代码。

## 各入口的威胁面

| 入口 | 允许的权限 | 强制限制 | 证据与限制 |
| --- | --- | --- | --- |
| 包内 `main` 外壳 | 窗口拖动与三个已注册外壳命令 | 唯一 capability 仅匹配 `main` WebView；包内资源使用上述精确 CSP | capability 与 CSP 源码测试；安装后的 WebView 行为仍需平台验收 |
| `splash` WebView | 无原生命令 | 无匹配 capability，并使用包内页面 CSP | capability 与页面资源测试；平台行为仍未验证 |
| 已认证 Host WebView | Host HTTP 内容及其 DSH 工具 | 独立 WebView；精确数字回环 HTTP 来源与端口；无原生 capability | Rust URL 单元测试；不会约束 MCP、Office 或 RPA provider 中的每项操作 |
| Office 许可说明文档视图 | 显示精确的同源说明页 | 无原生 capability；路径精确且不带查询参数；导航保持在该路径 | URL 分类测试；跨平台文档渲染与文件副作用仍未验证 |
| 外部浏览器交接 | 不含凭据的外部 HTTP(S) 引用 | 启动前拒绝回环地址、本地名称、内嵌凭据及可执行协议 | URL 分类测试；操作系统浏览器行为不由应用强制 |
| 进程内插件 | Host 进程权限 | WebView ACL 不会隔离加载到 Host 进程中的插件 | 仅采用可信代码假设；尚未实现恶意同进程插件隔离 |

桌面 profile 的只读 sandbox 与需询问审批默认值适用于新 profile 中的 DSH 工具执行；这不能证明每个集成都通过这些控制处理所有副作用。现有用户设置会保留。跨平台真实文件副作用、完整 MCP/Office/RPA 执行约束及恶意同进程插件隔离，不在这些源码检查的验收范围内。

## Alternatives considered

**授权给父窗口或 localhost 通配符。** 这些规则会授权子视图或无关监听器。[原生窗口决策](../feature/2026-09-13-clawmaster-native-window-titlebar.zh.md)已经将拖动与窗口控件交给原生装饰。

**为进度更新允许内联资源。** 本地脚本和样式表文件提供包内页面的行为与外观；进度更新由本地脚本设置样式属性，无需授予通用的内联资源例外。

## Consequences

Host 内容不能调用外壳生命周期命令。原生回调根据已解析 URL 选择浏览器或无原生权限的 Office 许可说明视图，不暴露任意启动器命令。启动失败日志省略 URL，因为查询参数可能含私人数据。后续原生操作需要明确审核的 capability。任意恶意 Host 插件不会被 WebView ACL 隔离。

Rust URL 测试拒绝错误端口、来源、凭据和非 HTTP 目标。实际应用 ACL 能够编译，策略测试拒绝按窗口或远程来源授权。这些源码检查不能证明跨平台已安装 WebView 行为；打包后原生交互仍是独立验收要求。
