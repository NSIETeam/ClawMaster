# Agent Note: Preserve updater preferences during legacy self-upgrade

Status: implemented

[English](2026-09-18-updater-legacy-profile-migration.md) | 中文

## Problem

已安装的更新器 `0.1.0` 和 `0.1.1` profile 可能包含用户选择的更新通道或停用选项。更新更新器时需要修改入口 URL；若替换整个 profile 行，就可能抹掉这些选择。把每个扩展行都当作未知编辑，也会阻止这些用户升级。

## Decision

只有当更新器所属 profile 行的现有入口指向已验证的组件安装记录时，激活才会修改该行的 `name` 标量。它保留 `config` 和 `disabled` 的 YAML 原始字节，因此显式通道 URL 和用户的停用选项都会保留。配置必须通过当前更新器 schema，`disabled` 必须为布尔值，且该行只允许包含 `id`、`name`、`config` 和 `disabled`。未知字段或无效配置会在 profile 与操作日志变更前中止激活，并返回离线恢复说明。

更新器 `0.1.0` 和 `0.1.1` 默认使用旧原生 manifest 地址；`0.1.2` 默认使用 v2 地址。未显式指定通道的 profile 会采用新版本的 v2 默认值。显式 URL 属于用户配置，因此保持不变。激活会记录完整的更新前后 profile 文本，现有的批准回滚流程可同时恢复旧入口及用户设置。重启维护遇到用户明确禁用的更新器，或切换到低于 `0.1.2` 且不支持当前 Host 健康回执的版本时，会记录为 `selected-unverified` 终态。该状态保留用户选择，不声称更新器已加载，也不会在每次启动时反复自动回滚。

## Alternatives considered

**替换整个更新器行。** 这会静默丢弃自定义通道设置和 `disabled: true`，因此激活只修改经过验证的入口标量。

**猜测未知字段或 URL 的转换方式。** 新配置字段可能改变行为，自定义端点也可能是有意选择。因此迁移拒绝无法识别的行字段或不符合 schema 的配置，并保持原始字节不变。

**再安装一条更新器行。** profile 已经标识了一个更新器所有者，重复行可能加载冲突版本。因此迁移切换已验证的所有者。

## Consequences

已知的 `0.1.0` 和 `0.1.1` 行可通过批准更新及重启流程升级，同时保留可识别的设置。禁用或旧版本选择会作为未验证的终态保留，直到用户明确选择回滚或更新。未知 profile 格式要求操作人员停止 ClawMaster、备份 profile 和更新器数据，再恢复已知可用的 profile 备份或请求管理员离线修复。测试使用仓库中的组件安装记录与操作日志格式模拟这两个历史版本；测试不能替代 Apple Silicon、Windows x64 或 Linux 上的安装后升级验收。
