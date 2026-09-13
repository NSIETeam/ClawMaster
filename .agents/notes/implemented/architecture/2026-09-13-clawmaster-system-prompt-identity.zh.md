# Agent Note: ClawMaster 系统提示身份

Status: implemented

[English](2026-09-13-clawmaster-system-prompt-identity.md) | 中文

## 问题

桌面需要独立的企业协作身份，同时继续复用 DSH 的提示组装与扩展 API。

## 决定

[`clawmaster-sys-prompt`](../../../../apps/desktop-tauri/sys-prompt/README.zh.md) 重导出原始 DSH 服务与具名 API。桌面策略禁用上游 `system-prompt` 条目，插入 `clawmaster-sys-prompt` 条目，并使用上游的 `includeHarnessIdentity` 和角色说明字段。产品角色说明使用 ClawMaster 与 WatchDog 身份，将业务系统作为 AI 工具和数据，并将受保护操作交由实际审批服务决定。

裁剪安装包携带该组件，并从本地工作区解析 DSH。官方 DSH profile 保留自己的默认值。提示文本不会替代工具授权或增加访问权限。

## 考虑过的替代方案

**分叉提示组装实现。** 分叉会重复桌面已经复用的注册机制、上下文和渲染行为。

**重命名上游包。** 修改 DSH 包身份会影响现有依赖和插件使用方。产品组合别名能够保留这些 API。

**通过补丁修改条目名称。** Include 插件将补丁的 `name` 用作匹配条件。名称不同会跳过补丁，因此替换服务使用既有的禁用与插入操作。

## 影响

产品身份可独立配置，组装与日志语义仍由 DSH 负责。用户配置必须指向产品条目；使用旧 id 的配置仍属于已禁用的上游条目。组件 README 负责覆盖配置与明确选择上游服务的说明。

无密钥检查通过 Include 应用实际的基础、Web 和桌面补丁层，拒绝警告或多个有效提示服务，并使用真实工具说明与审批上下文组装所选条目。其负对照会拒绝名称不匹配的补丁。发布启动测试覆盖组合后的桌面 profile。
