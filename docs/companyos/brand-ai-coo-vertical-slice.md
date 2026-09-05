# Brand AI COO vertical slice

本模块是 Issue #17 的第一阶段实现，位于 `packages/server/src/modules/company_os`，不进入 `packages/core` runtime kernel。

## 复用与边界

- `organizationId`、授权和现有 integration adapter 作为真实接入边界；本模块不复制账号/租户系统。
- `InMemoryEventBus` 是可替换的契约级实现：生产接线应替换为现有数据库 outbox/inbox 与持久 consumer offset。
- `BrandWatchdog` 只产生有证据的建议，不执行外部副作用；执行必须接既有 policy/approval/workflow/audit 路径。
- Owl/知了猴的事件通过 `CanonicalEvent` 投影进入；未配置 connector 必须返回 unavailable/blocked，而不是成功。

## 已完成

- Canonical money/freshness/event/action/audit contracts。
- Profit Engine v1：整数金额、成本缺失时 unknown、SKU 维度汇总、贡献利润率。
- 去重事件发布与按 consumer 的 at-least-once 消费语义。
- Watchdog `event → recommendation → evidence-linked action → audit`。
- CEO Brief 的 Revenue/Margin、风险、机会、建议/执行/待决策分栏。
- 覆盖租户隔离、重复事件、缺成本、价格/GMV 异常的确定性测试。

## 未完成与下一步

- 持久 Event Bus/outbox、数据库 migration、真实 Connector readiness/sync cursor。
- Inventory/Cash/Growth Engine、预测校准、真实猫头鹰/知了猴 OAuth/API 连接。
- Desktop 首页与真实 Design Partner 验收；当前测试不替代 live/production 证据。
- 下一 PR 应接入 server composition/routes，并把 action 执行接到 policy/approval/workflow/audit 的真实持久路径。
