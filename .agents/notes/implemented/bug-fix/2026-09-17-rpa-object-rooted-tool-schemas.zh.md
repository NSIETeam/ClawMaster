# Agent Note：RPA 工具发布以对象为根的 JSON Schema

状态：已实现

[English](2026-09-17-rpa-object-rooted-tool-schemas.md) | 中文

## 问题

RPA 组件把属性映射直接注册为 `ToolDefinition.parameters`。DSH 和模型提供方把该字段视为 JSON Schema 文档，根节点必须声明 `type: object` 和 `properties`。因此模型收到的工具 schema 缺少对象类型并被判定为无效。

## 决策

将 `rpa_run`、`rpa_native` 和 `rpa_call` 的参数发布为显式的对象根 JSON Schema。必填字段放入根 `required` 数组，拒绝未知顶层字段；原生工具参数因工具而异，因此保留内部 `arguments` 对象的开放属性。

## 考虑过的替代方案

**把 `parameters` 当作隐式属性映射。** DSH 工具注册表会将该字段作为 JSON Schema 转发，不会替手写工具定义推断对象根，因此模型侧 schema 仍然无效。

**允许未知顶层字段。** 三个 RPA 入口的顶层参数固定；额外字段没有受支持的行为，只会让输入契约变得不明确。

## 后果

三个 RPA 工具现在都暴露模型 API 所要求的 schema 格式。回归测试检查根类型、声明属性、必填字段和有意开放的嵌套 `arguments` 对象，不依赖原生助手二进制。
