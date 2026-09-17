# Agent Note: ClawMaster 外壳 CSP 与 capability 范围

Status: implemented

[English](2026-09-16-clawmaster-shell-csp-capability.md) | 中文

## 问题

打包外壳的 capability 同时覆盖 splash 与 main 标签，Host 内容 WebView 只能依靠排除标签来避免权限。外壳行为和样式都是静态本地资源，但 CSP 仍允许内联样式。

## 决策

三个原生窗口命令只授予 `main` 外壳 WebView。splash 和 Host 内容不出现在任何 capability 条目中。把外壳和启动页的行为、样式移到本地文件，再使用只允许同源脚本和样式且不包含内联例外的 CSP。

Host 页面由 DSH 前端发布目录提供。由于 Tauri 的打包页面 CSP 不会为这个外部 loopback 页面设置响应头，Host 页面使用自身的响应 CSP。策略会对启动时精确的内联脚本和样式区块计算摘要，只允许同源脚本文件和请求，仅允许本地预览 frame 与 worker，并阻止内联事件处理器及原生对象。样式属性例外仅支持 DSH 界面渲染的布局值。

## 后果

Host 内容无法通过匹配的 capability 调用桌面命令，启动页也无法获得外壳控制能力。打包外壳通过本地资源保持可用，同时 CSP 不允许 `unsafe-inline` 或 `unsafe-eval`。即使单独提供的 Host 文档包含 DSH 启动代码，也会拒绝策略中没有列出的内联脚本。这些策略保护 WebView 不受注入页面内容影响，但不能把同进程内受信任的 DSH 插件彼此隔离。

## 考虑过的方案

**只依赖 Tauri 外壳 CSP。** 这无法为 DSH Host 页面提供响应策略，因为运行时通过 loopback 提供该页面。

**允许所有内联脚本。** 这会放行不属于当前 Host 文档的脚本；对精确内联区块计算摘要则能保留启动代码并拒绝后续注入。
