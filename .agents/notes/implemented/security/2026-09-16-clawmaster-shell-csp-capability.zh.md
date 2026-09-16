# Agent Note: ClawMaster 外壳 CSP 与 capability 范围

Status: implemented

[English](2026-09-16-clawmaster-shell-csp-capability.md) | 中文

## 问题

打包外壳的 capability 同时覆盖 splash 与 main 标签，Host 内容 WebView 只能依靠排除标签来避免权限。外壳行为和样式都是静态本地资源，但 CSP 仍允许内联样式。

## 决策

三个原生窗口命令只授予 `main` 外壳 WebView。splash 和 Host 内容不出现在任何 capability 条目中。把外壳和启动页的行为、样式移到本地文件，再使用只允许同源脚本和样式且不包含内联例外的 CSP。

## 后果

Host 内容无法通过匹配的 capability 调用桌面命令，启动页也无法获得外壳控制能力。打包外壳通过本地资源保持可用，同时 CSP 不允许 `unsafe-inline` 或 `unsafe-eval`。这保护 Tauri 外壳表面，但不能把同进程内受信任的 DSH 插件彼此隔离。
