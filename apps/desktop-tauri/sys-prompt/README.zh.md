---
description: "通过现有 DSH 系统提示组装提供 ClawMaster 与 WatchDog 身份。"
kind: "package-reference"
---
# clawmaster-sys-prompt

[English](README.md) | 中文

## 概述

ClawMaster 在 WatchDog 中使用企业协作身份，同时保留 DSH 的工具指引和运行时上下文。业务组件主要为 AI 工作提供工具和数据。可用工具及当前审批服务决定哪些操作能够执行。

## 配置

[桌面策略](../defaults/cordis.patch.yml) 禁用上游 `system-prompt` 配置行，并以 `clawmaster-sys-prompt` 插入此模块。其配置关闭上游身份开场，并提供产品角色说明。全部配置字段由 [DSH SystemPrompt](../../../packages/core/system-prompt/README.zh.md) 定义。

用户 profile 补丁最后生效，定制当前服务时必须指定 `id: clawmaster-sys-prompt`。指定 `id: system-prompt` 的补丁只会修改已禁用的上游条目，其配置不会迁移。配置补丁会替换整个对象，因此须保留 `includeHarnessIdentity: false` 和其他需要的字段。

如需明确选择上游服务，应在同一用户补丁中禁用 `clawmaster-sys-prompt` 并启用 `system-prompt`。同时启用两个条目会竞争注册同一个服务。

## 实现

[index.mjs](index.mjs) 重导出原始默认服务和全部具名运行时 API。打包后组件位于 `apps/clawmaster-sys-prompt`，依赖解析到同一安装目录。组件不引入独立的组装器、schema、权限策略或日志实现。

## 模型体验

提示以 ClawMaster 的 WatchDog 企业协作身份开头。DSH 通过既有注册机制提供工具说明和运行时上下文快照。

## 已知限制与后续工作

- 角色说明不会授予业务访问或审批权限，相关决定由已配置的服务执行。
- 此模块属于桌面组合组件，没有独立应用入口。
