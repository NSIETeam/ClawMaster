---
description: "WatchDog 持久提示计划、逐次审批、工作进程恢复与认证观察接口。"
kind: "package-reference"
---

# WatchDog 持久调度

[English](README.md) | 中文

## 概要

WatchDog 将产品计划、执行实例、授权、工作进程租约和历史保存在企业数据库旁的 `schedules.sqlite` 中。规则校验与固定频率计算复用 DSH 官方 Schedule，取消与生命周期归属复用 DSH Jobs，交付使用活动 agent 的持久收件箱。原有的会话内 Schedule 提醒保持独立。创建产品计划不代表授权未来执行。

## 目录

- [执行与审批](#execution-and-approval)
- [恢复](#recovery)
- [认证接口](#authenticated-interfaces)
- [部署配置](#deployment-settings)
- [验证边界](#verification-limits)

<a id="execution-and-approval"></a>
## 执行与审批

每个实例首先处于 `waiting_approval`。已认证的人可以通过命令接口批准这个具体实例。Agent 可以通过 `watchdog_schedule_command` 请求同一授权；DSH 必须在已开启的对话回合中返回 `allowed-once`。审批响应者缺席、审批被禁用、治理服务不可用或授权过期都不会授权执行。批准的有效期截止于 `createdAt + approvalTimeoutMs`，包含等待所属会话上线或重试交付的时间。创建计划、恢复工作进程和重新打开桌面都不会批准实例。

交付时重新检查绑定会话当前的任务写入资源权限及发起成员。企业模式还检查当前委派关系，并通过已配置的治理身份服务消耗独立、绑定对象的审批。其命令标识为实例标识，generation 与 revision 均为零，摘要覆盖不可变的计划标识、实例标识、预定时间和提示词。成员权限被撤销或会话更换所属成员会阻止派发。这个实例授权仅允许发送提示词；执行期间仍须遵守各工具的 DSH 与企业审批。

Host 只向计划绑定会话中已经在线的根 agent 派发。它不会恢复冷会话、转移凭据或创建操作系统服务。`desktop` 与 `server` 描述显式配置的 Host 部署方式：桌面关闭即停止工作；服务器执行需要运维人员管理的、持续运行的 DSH Host 及在线绑定根 agent。关机或休眠的主机不会执行任务。不同机器上的独立数据库副本不是互相协调的工作进程；共享执行应使用同一个已授权服务器及其本地账本。

`dispatched` 确认带标识的提示词已经通过会话持久化屏障。它不代表模型成功、业务任务验收通过或外部系统收到消息。需分别检查会话和业务任务证据。调度器不发送外部通知，也不取消已经派发的对话回合。

<a id="recovery"></a>
## 恢复

每个实例具有唯一的 `(planId, scheduledAt)` 标识。SQLite 串行执行领取操作，记录租约持有者、到期时间、尝试次数和隔离代次。多个工作进程必须共享一个本地账本及相同的持久化限制。派发前过期的领取可以按有界指数退避重试。入队前先持久化不可重放的派发屏障；越过屏障后崩溃或无法确认落盘，会变成 `uncertain`，绝不自动重放。这阻止了不确定崩溃后的自动重复派发；它不是对任意模型副作用的恰好一次保证。

已认证的人通过原会话中的实例标识检查 `uncertain`，然后提交 `resolve-uncertain`，选择 `acknowledge-dispatched` 或 `cancel` 并填写理由。两种操作都会保留只追加的审计条目，都不会重新入队或撤销已经产生的外部影响。Agent 不能自行消除不确定状态。`cancel-plan` 停止生成后续实例；`cancel-instance` 单独撤销尚未越过派发屏障的实例并使旧租约失效。

漏跑策略为 `skip`、`coalesce` 和 `catch-up`。跳过策略仅接纳最新且迟到不超过 `onTimeGraceMs` 的一次；合并策略接纳最新到期实例；补跑策略至多接纳配置数量的最近实例。每计划待处理容量限制连续多轮补跑，放弃的次数累加到 `missedCount`。固定频率以 UTC 为锚，不受本地夏令时切换影响；单次本地时间使用 DSH 的显式时区与歧义校验。时钟回拨不会倒退持久游标。

数据库级活动租约与滚动派发次数预算共同限制多进程接纳量。预算包含进入派发屏障的尝试，也包含不确定尝试；它不是金额或模型 token 配额。会话离线和入队前失败都有有限重试次数。审批到期、重试耗尽和不确定状态均持久化且可查询。心跳报告 `online`、`degraded`、`offline` 或 `stopped`；独立观察者无需活动 agent 或正在工作的调度器，就能读取过期心跳和租约事实。心跳状态不证明模型或业务成功。

<a id="authenticated-interfaces"></a>
## 认证接口

所有路径使用已有的认证 DSH Fetch 传输层，以及业务任务相同的治理 `task.read` / `task.write` 资源检查。单个计划以其标识作为资源；列出所有计划要求 `*`。跨组织调用者会被拒绝。查询有可配置的字节限制，每页最多 100 条。工具限制计算完整的 DSH value 与渲染文本封装，包括 JSON 转义。分页会在传输层预算内缩短，但保留完整记录；`nextAfter` 指向最后一条已返回记录，不会跳过下一条。如果第一条完整记录连同工作进程观察信息仍放不下，会明确返回 `response_too_large`，而不是返回无法前进的空续页。命令回执超过传输层预算时，事务在提交前回滚。未知或重复的查询字段，以及非布尔形式的 history 选择值都会被拒绝。

| 接口 | 输入与结果 |
| --- | --- |
| `GET /api/clawmaster/schedules` | 计划分页、实际部署模式和独立工作进程状态。 |
| `GET /api/clawmaster/schedules?id=PLAN` | 实例分页，包括预定时间、审批期限、租约、尝试次数、原因与完成时间。 |
| `GET /api/clawmaster/schedules?id=PLAN&history=true` | 只追加的决策和操作者记录。 |
| `after` / `limit` | 使用响应的 `nextAfter` 游标继续读取；字节预算可能使返回的完整记录少于 `limit`。 |
| `workersAfter` | 使用 `workerSummary.nextAfter` 独立继续读取工作进程列表；历史查询要求此游标为零。 |
| `workerSummary` | 按 `online`、`degraded`、`offline`、`stopped` 统计所有工作进程，包括后续页中的进程；`total` 和 `nextAfter` 明确标记部分列表。 |
| `POST /api/clawmaster/schedules/command` | 人提交的 JSON `{commandId,command}`；完全相同的重试返回已保存回执。 |
| `watchdog_schedule_query` | 已授权 agent 使用的同样有界读取字段。 |
| `watchdog_schedule_command` | `request` 字符串包含命令 JSON；每个命令都要求 DSH 单次审批。 |

观察使用稳定的行游标，不刷新心跳、不恢复租约、不清理工作进程，也不追加审计条目。工作进程每页至多包含 100 条完整记录，与请求的计划页或实例页共享传输层字节预算。历史分页不携带工作进程观察信息。

命令要么定义不可变计划，要么执行状态迁移。`create` 接收 `id`、`sessionId`、`prompt`、`rule`、`missed` 与 `catchUpLimit`。规则示例为 `{kind:"every",everySeconds:300}` 或 `{kind:"at",at:"2026-12-01T09:00:00+08:00"}`；`at` 也接受 DSH 的 `{date,time,time_zone}` 输入。`approve` 接收计划 `id` 与 `instanceId`；取消操作另需 `reason`；`resolve-uncertain` 另需 `resolution` 和 `reason`。命令标识不能由另一操作者或载荷复用。任何命令都不接受模型 JSON 自报的身份、组织、权限或审批回执。

<a id="deployment-settings"></a>
## 部署配置

Host 接受 `scheduleDatabasePath` 和 `watchdogSchedules`。未指定路径时，数据库位于配置的企业数据库目录下，名为 `schedules.sqlite`。限制在加载时校验，并与组织绑定一同保存；限制不同的工作进程无法打开账本。修改持久限制需要经过审查的显式迁移，不会在重启时隐式重新解释。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `desktop` | 桌面或显式运维的 `server`；不安装守护进程。 |
| `busyTimeoutMs` | 5000 | 单次操作等待 SQLite 锁的最长时间。 |
| `pollMs` / `leaseMs` | 1000 / 30000 | 墙钟采样间隔与派发领取最长时间。 |
| `heartbeatStaleMs` | 15000 | 独立读取者判断离线的阈值。 |
| `maxPlans` / `maxMaterializePlans` | 1000 / 64 | 全生命周期计划容量与每轮检查的到期计划数。 |
| `maxPendingPerPlan` | 10 | 每个计划保留的未完成实例总量。 |
| `maxConcurrent` | 2 | 跨工作进程的活动派发租约数。 |
| `maxDispatchesPerWindow` / `budgetWindowMs` | 10 / 3600000 | 滚动派发尝试接纳预算。 |
| `approvalTimeoutMs` | 3600000 | 从生成实例起计算的审批与交付期限。 |
| `retryBaseMs` / `retryMaxMs` / `maxAttempts` | 1000 / 60000 / 5 | 屏障前退避及有限尝试次数。 |
| `onTimeGraceMs` | 5000 | 跳过策略允许的最新实例迟到时间。 |
| `maxQueryBytes` | 262144 | HTTP 或工具结果序列化后的最大字节数。 |

<a id="verification-limits"></a>
## 验证边界

包内测试覆盖真实 SQLite 工作进程、崩溃恢复、正式 DSH Jobs 提供者、AgentLoop 与 JSONL 持久化、审批缺席、权限撤销、有界重放、过期心跳观察，以及固定模型输入快照。测试使用临时状态和合成模型。它们不验证已安装桌面的休眠唤醒、服务器服务管理、实际模型计费、外部交付、多主机网络文件系统或已授权的凭据迁移。管理界面必须显式接入这些接口才能暴露计划控制；现有会话提醒控件不会创建这些产品计划。
