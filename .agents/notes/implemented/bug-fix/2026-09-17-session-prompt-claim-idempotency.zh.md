# Agent Note: Session 提示词领取阶段幂等

Status: implemented

[English](2026-09-17-session-prompt-claim-idempotency.md) | 中文

## 问题

AgentLoop 已领取 inbox 消息、但尚未记录 `user/message` 时，Session 提示词重试可能到达。在这段时间内，实时队列检查与持久化用户历史都看不到匹配的请求标识，因此重试可能再次受理并造成重复工作。

## 决定

`SessionCommandController` 将匹配的 `agent/inbox/spliced` 插入事件视为持久化受理证据。AgentLoop 在领取消息前追加该事件；事件携带插入的用户消息及其 `rpcId`。因此，在领取与写入历史之间重试时，控制器会返回原受理结果，同时保留现有的实时队列与 `user/message` 检查。真实 AgentLoop pre-step 屏障测试会在此间隔用同一请求标识重试，并验证只产生一条持久用户消息与一次模型请求。

## 考虑过的替代方案

**只检查当前 inbox 与 `user/message` 历史。** 领取会先从投影中移除消息，而 `user/message` 尚未写入，因此这两个来源之间确实存在空窗。

**维护独立的进程内已完成请求注册表。** 这会重复保存已有的持久 inbox 记录，并在进程重启后丢失其依据。

## 后果

AgentLoop 领取工作后，重试仍通过现有 Session 日志保持幂等。此保证依赖 inbox 插入事件保留请求标识并先于领取，当前 AgentLoop 持久化路径满足这一顺序。集成测试覆盖真实 AgentLoop 路径，并检查持久消息与提供方请求数。
