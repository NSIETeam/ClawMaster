# Brand AI COO vertical slice

本模块是 Issue #17 的第一阶段实现，位于 `packages/server/src/modules/company_os`，不进入 `packages/core` runtime kernel。

## 复用与边界

- `organizationId`、授权和现有 integration adapter 作为真实接入边界；本模块不复制账号/租户系统。
- `InMemoryEventBus` 只用于纯领域测试；`DurableCompanyOsEventBus` 使用企业数据库中的事件与 consumer receipt 表，处理成功后才确认，重启后不会重复投影已确认事件。
- `BrandWatchdog` 只产生有证据的建议，不执行外部副作用；执行必须接既有 policy/approval/workflow/audit 路径。
- Owl/知了猴的事件通过 `CanonicalEvent` 投影进入；未配置 connector 必须返回 unavailable/blocked，而不是成功。

## 已完成

- Canonical money/freshness/event/action/audit contracts。
- Profit Engine v1：整数金额、成本缺失时 unknown、SKU 维度汇总、贡献利润率。
- 去重事件发布与按 consumer 的 at-least-once 消费语义；重复幂等键若对应不同事实会明确冲突。
- Watchdog `event → recommendation → evidence-linked action → audit`。
- CEO Brief 的 Revenue/Margin、风险、机会、建议/执行/待决策分栏。
- Profit Engine 拒绝混租户输入，事件消费键包含 organizationId，避免相同外部事件 ID 跨租户碰撞。
- SQLite schema 24 与 PostgreSQL migration 15 都包含组织级事件唯一键和持久 consumer receipt；失败处理不会提前确认。
- 覆盖租户隔离、重复/冲突事件、缺成本、价格/GMV 异常的确定性测试。

本地交付提交：`9002108a` 恢复原 PR #19 纵切，`932a3641` 补齐上述租户与幂等完整性门禁。

## 未完成与下一步

- 认证 HTTP 路由、集群 PostgreSQL repository、真实 Connector readiness/sync cursor。
- Watchdog Action/Task/Audit 的数据库持久化和并发 consumer lease/fencing。
- Inventory/Cash/Growth Engine、预测校准、真实猫头鹰/知了猴 OAuth/API 连接。
- Desktop 首页与真实 Design Partner 验收；当前测试不替代 live/production 证据。
- 下一 PR 应接入 server composition/routes，并把 action 执行接到 policy/approval/workflow/audit 的真实持久路径。
