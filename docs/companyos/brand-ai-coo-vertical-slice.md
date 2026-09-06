# Brand AI COO vertical slice

本模块是 Issue #17 的第一阶段实现，位于 `packages/server/src/modules/company_os`，不进入 `packages/core` runtime kernel。

## 复用与边界

- `organizationId`、授权和现有 integration adapter 作为真实接入边界；本模块不复制账号/租户系统。
- `InMemoryEventBus` 只用于纯领域测试；`DurableCompanyOsEventBus` 使用企业数据库中的事件与 consumer receipt 表，处理成功后才确认，重启后不会重复投影已确认事件。
- `/enterprise/companyos/*` 路由复用企业账号与管理员 principal；组织范围只取服务端身份，不接受请求体覆盖。
- `BrandWatchdog` 只产生有证据的建议，不执行外部副作用；执行必须接既有 policy/approval/workflow/audit 路径。
- Owl/知了猴的事件通过 `CanonicalEvent` 投影进入；未配置 connector 必须返回 unavailable/blocked，而不是成功。

## 已完成

- Canonical money/freshness/event/action/audit contracts。
- Profit Engine v1：整数金额、成本缺失时 unknown、SKU 维度汇总、贡献利润率。
- 去重事件发布与按 consumer 的 at-least-once 消费语义；重复幂等键若对应不同事实会明确冲突。
- Watchdog `event → recommendation → evidence-linked action → audit`。
- CEO Brief 的 Revenue/Margin、风险、机会、建议/执行/待决策分栏。
- Profit Engine 拒绝混租户输入，事件消费键包含 organizationId，避免相同外部事件 ID 跨租户碰撞。
- SQLite schema 27 与 PostgreSQL migration 15 都包含组织级事件唯一键、持久 consumer receipt 和带递增 fence token 的 consumer claim/lease 数据契约；失败处理不会提前确认。
- SQLite 持久化 Watchdog Action/Task/Audit 投影，Task 只进入 `pending_decision`，事务提交后的重放依靠稳定 ID 和唯一约束保持幂等。
- SQLite consumer 原子领取单条事件；活跃租约阻止并发 worker 重复处理，过期租约允许更高 fence token 接管，旧 worker 不能再确认或提交 Watchdog 投影。
- 认证 HTTP 路由支持事件写入、租户级 Watchdog 检查、Action/Task 查询和管理员 Audit 查询；管理员触发检查不会处理其他租户事件。
- 集群模式使用独立异步 PostgreSQL authority，不回退 SQLite；通过 `FOR UPDATE OF event SKIP LOCKED` 领取事件，并在独立事务内重新校验 owner/fence/租约后原子写入 Action/Task/Audit/Receipt。
- clustered server 挂载与本地模式同等的 CompanyOS 认证路由，组织范围来自 PostgreSQL 会话或管理员 principal。
- 本地与集群模式都要求管理员显式批准或拒绝 Task；批准只把 Action 置为 `queued`，拒绝置为 `rejected`，重复同一决定幂等、冲突决定返回错误，并写入 human Audit。
- `BusinessDataConnectorV1` 定义 capability/schema version、冲突策略、限流、HTTPS、opaque secretRef、readiness 和同步 cursor；猫头鹰/知了猴 descriptor 与 fixture 已加入，但 fixture 固定为 `fixture_only`，不能作为生产 ready 证据。
- 覆盖租户隔离、重复/冲突事件、缺成本、价格/GMV 异常和持久化重放的确定性测试。

本地交付提交：`9002108a` 恢复原 PR #19 纵切，`932a3641` 补齐上述租户与幂等完整性门禁。

## 未完成与下一步

- 在真实 PostgreSQL 实例执行 migration、并发多副本 claim/超时接管与重启恢复验收；当前 mock SQL 测试不替代真实集群证据。
- 猫头鹰/知了猴真实 API adapter、HTTPS、租户授权、secret provider 与 live readiness/sync cursor，以及 queued Action 到真实外部动作的 policy/confirmation、执行回执、`unknown_outcome` 对账与恢复。
- Inventory/Cash/Growth Engine、预测校准、真实猫头鹰/知了猴 OAuth/API 连接。
- Desktop 首页与真实 Design Partner 验收；当前测试不替代 live/production 证据。
- 下一阶段应在真实 PostgreSQL 上验收异步 repository，再把 action 执行接到 policy/approval/workflow/audit 的真实持久路径。
