# Agent Note: 安装 wheel 的真实 API 测试在外部密钥缺失时自跳过

Status: implemented

[English](2026-09-23-python-live-preflight-self-skip.md) | 中文

## 问题

Python release-shaped CI 矩阵在两个平台同时硬失败：`DEEPSEEK_API_KEY_EXTERNAL is empty; the installed-wheel real API test cannot self-skip`。这个可复用工作流本就把该 secret 声明为 `required: false`，本仓库从未配置过它，且仓库自身的 e2e 政策就是"真实 API 测试无 DEEPSEEK_API_KEY 时自跳过"——预检与这三者全部矛盾。失败纯属 CI 管道问题：在 `desktop-v0.0.1-beta` 发布线的首次全量 CI 里，构建、wheel、全部无密钥黑盒测试早已通过。

## 决策

两个预检步骤改为输出 `::warning::` 并导出 `has-key` 步骤输出，不再失败；两个 `Run installed-wheel real API black-box test` 步骤额外要求 `steps.preflight-*.outputs.has-key == 'true'`。配置了 secret 时行为与原来逐字节一致；未配置时真实 API 测试带可见警告跳过，与 e2e 政策一致。

## 备选方案

**在仓库配置 `DEEPSEEK_API_KEY_EXTERNAL`。** 暂不采纳：该凭证属于产品管理，其缺失不应阻塞桌面 beta；后续补配无需改动任何工作流。

**直接删除预检步骤。** 否决：有密钥时预检虽然冗余，但显式输出让跳过决策可观察，且被 `scripts/ci-workflow.spec.ts` 钉住。

## 后果

Python release-shaped 矩阵无需外部凭证即可转绿，发布线的首次全量 CI 可以按真实信号评估。真实 API 的覆盖缺口从红色失败变成可见警告；secret 一旦配置即自动闭合。
