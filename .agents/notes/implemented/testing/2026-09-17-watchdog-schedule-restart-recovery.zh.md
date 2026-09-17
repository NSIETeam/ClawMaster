# Agent Note: WatchDog 调度重启恢复

Status: implemented

[English](2026-09-17-watchdog-schedule-restart-recovery.md) | 中文

## 问题

仅有账本游标测试，无法证明重启后的 Host 能安全地把经过的计划时间转成一条已持久化的 DSH 消息。

## 决策

[`watchdog-schedule-host.scenario.mjs`](../../../../frontends/dsh/tests/watchdog-schedule-host.scenario.mjs) 中的 Host 场景会关闭真实 SQLite 连接和 DSH 调度运行时，再打开同一个账本，并将注入的墙钟向前推进十五分钟。测试核对合并策略只生成最近一次错过的固定频率实例，重启不会自动批准，并且只有显式人工批准后，真实 DSH Jobs 与 AgentLoop 路径才会持久化一条实例消息。重复调度周期不会再次入队。

该测试用合成模型和受控时钟证明应用层重启恢复。它不能证明已安装桌面会在操作系统休眠后唤醒、外部服务器服务会持续运行，或 Host 不可用时运维人员仍会收到告警。这些结果需要目标操作系统、服务管理器和独立告警目的地。

## 考虑过的替代方案

**只测试实例账本。** 账本测试可以证明游标和租约迁移，但不会经过 DSH Jobs、AgentLoop、Session 持久化或 Host 重启后的审批边界。

**从受控时钟测试推断已安装桌面恢复。** 测试没有挂起主机，也没有执行电源管理流程，因此这种结论超出了证据范围。

## 后果

该验收场景无需模型 API 即覆盖 Host 生命周期与收件箱一次入队边界。已安装桌面休眠恢复和服务器服务管理仍需分别验收。
