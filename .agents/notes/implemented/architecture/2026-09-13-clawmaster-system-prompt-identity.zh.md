# Agent Note: ClawMaster 系统提示身份

Status: implemented

[English](2026-09-13-clawmaster-system-prompt-identity.md) | 中文

## 问题

桌面需要独立的企业协作身份，同时继续复用 DSH 的提示组装与扩展 API。

## 决定

[`clawmaster-sys-prompt`](../../../../apps/desktop-tauri/sys-prompt/README.zh.md) 重导出原始 DSH 服务与具名 API。桌面策略在既有 `system-prompt` 配置行选择此组件，并使用上游的 `includeHarnessIdentity` 和角色说明字段。产品角色说明使用 ClawMaster 与 WatchDog 身份，将业务系统作为 AI 工具和数据，并将受保护操作交由实际审批服务决定。

裁剪安装包携带该组件，并从本地工作区解析 DSH。官方 DSH profile 保留自己的默认值。提示文本不会替代工具授权或增加访问权限。

## 考虑过的替代方案

**分叉提示组装实现。** 分叉会重复桌面已经复用的注册机制、上下文和渲染行为。

**重命名上游包。** 修改 DSH 包身份会影响现有依赖和插件使用方。产品组合别名能够保留这些 API。

## 影响

产品身份可独立配置，组装与日志语义仍由 DSH 负责。无密钥组装检查通过重导出的服务对比真实工具说明与审批上下文；发布启动测试覆盖组合后的桌面 profile。
