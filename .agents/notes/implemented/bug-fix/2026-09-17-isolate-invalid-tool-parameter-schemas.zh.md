# Agent Note：隔离无效工具参数 schema

Status: implemented

[English](2026-09-17-isolate-invalid-tool-parameter-schemas.md) | 中文

## Problem

一个已注册工具的参数 getter 或快照出错，就可能中止整个模型请求的组装。根类型不是对象的 schema 也可能进入要求模型函数格式的工具提供器。若用 DSH 参数校验器支持的子集检查外部 schema，还会错误拒绝 MCP 工具使用的合法 JSON Schema 关键字。

## Decision

注册表在构建原生或 PTC 投影时，分别快照每个工具的描述和参数 schema。投影参数必须是无损 JSON，且根节点 `type` 为 `"object"`；其他 JSON Schema 关键字均保留，不做子集校验。无效定义会从所有模型可见投影中移除，合法同级工具仍保留。直接派发会在审批或工具执行前重新检查相同条件，并拒绝执行。后续投影若成功，该定义的隔离状态会清除。

必需的 `run_code` 呈现传输若无法读取自身 schema，仍然快速报错。本隔离逻辑处理的是注册后的工具定义，不会捕获 Cordis 插件启动失败。

## Alternatives considered

- 对参数 schema 使用 `assertSupportedJsonSchema` 会拒绝 `$ref`、`$defs`、`format`、`anyOf` 等合法外部关键字。
- 一个可选工具损坏时拒绝整个注册表或模型请求，虽然严格，却会连带中断所有健康工具。
- 接受非对象根节点会把模型函数协议无法表达的 schema 发送出去。

## Consequences

无效工具可以为生命周期和诊断继续保留注册状态，但不会被展示或执行。诊断会标出工具名和失败类别，不会包含 getter 抛出的细节。Cordis 启动失败需要单独设计插件组合层的隔离。

## Verification

`packages/core/tools/tests/tools.spec.ts` 验证健康同级工具保留、不可读/有损/非对象 schema、扩展关键字保留，以及审批和执行前拒绝。`packages/core/tools/tests/ptc.spec.ts` 验证原生、PTC、SDK 投影移除同一个不可读工具，同时健康绑定仍可调用。
