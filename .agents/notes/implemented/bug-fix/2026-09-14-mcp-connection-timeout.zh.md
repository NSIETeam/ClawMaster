# Agent Note: 限制 MCP 启动发现时长

Status: implemented

[English](2026-09-14-mcp-connection-timeout.md) | 中文

## 问题

如果 MCP 服务器始终无法完成 `initialize` 或首次 `tools/list`，插件激活和重连尝试可能无限等待。

## 决策

为 stdio 和 Streamable HTTP 暴露 `connectionTimeoutMs`（默认 15 秒，并受运行时计时器上限约束）。超时会关闭受影响的代次，并沿用现有重连及启动错误策略。连接解析时若已收到关闭信号，会在发现工具前检查，避免失效代次注册工具。

## Alternatives considered

**继续依赖 SDK 内置期限。** SDK 期限不可配置，可能让激活等待超过部署可接受的时长。

**增加全局看门狗。** 全局计时器无法安全识别所属 MCP 代次；连接监督器已经拥有该生命周期。

## Consequences

慢速服务器必须在期限内完成初始化和首次发现，否则会进入重试。超时会先关闭代次，再处理重连，避免启动无限挂起和陈旧工具注册。

## Acceptance

- 配置模式生成超时默认值；
- 两种传输方式都可配置超时；
- 已关闭代次不会执行工具发现注册；
- MCP 聚焦测试和包级类型检查通过。
