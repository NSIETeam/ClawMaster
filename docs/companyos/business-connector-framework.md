# CompanyOS business Connector Framework

经营数据连接器位于 `packages/server/src/modules/integration_adapters`，通过
`BusinessDataConnectorV1` 向 CompanyOS 提供 canonical events。连接器是五个平台及未来
ERP/CRM/财务系统的接入边界，不在 runtime kernel 或模型循环中实现业务同步。

## 契约

每个连接器必须声明稳定 ID、provider、语义版本、canonical schema version、capabilities、
冲突策略、最大批量和最小同步间隔。每次同步输入包含 `organizationId`、HTTPS endpoint、
opaque `secretRef`、cursor 和 limit，输出包含 canonical events、nextCursor 和 hasMore。

- 协调器只校验并传递 `secretRef`，不接受或保存明文凭据。
- endpoint 非 HTTPS、secretRef 缺失或 secret provider 中不存在时状态为 blocked。
- 未安装连接器状态为 unavailable；provider probe 失败状态为 unavailable，不伪造 ready。
- readiness 输出不包含 endpoint 或 secretRef，并统一脱敏 provider message。
- 跨租户 event、超出声明上限的 batch 和非法 cursor 都 fail closed。
- fixture 的状态固定为 `fixture_only`，生产同步默认拒绝；仅测试显式 `allowFixture` 可运行。

## P0 descriptors

- `owl-pricing-v1`：`pricing.anomalies.read`，用于猫头鹰价格异常事实。
- `zhilemon-commerce-v1`：`commerce.performance.read` 和
  `commerce.refunds.read`，用于知了猴 GMV/退款事实。

当前提供的是 descriptor、协调器和确定性 fixture，不是两个平台的真实 API 实现。已知猫头鹰
`http://8.141.8.31` 与知了猴 `http://47.116.30.60:18787` 均为 HTTP，按安全契约必须报告
`blocked/insecure_endpoint`。完成真实接入还需要平台侧 HTTPS、API schema、租户授权、只存于
secret provider 的凭据、限流参数，以及同步游标和失败恢复的 live evidence。

成员可通过 `GET /enterprise/companyos/connectors` 查看自己组织的内置连接器状态。本地 SQLite
服务与 clustered PostgreSQL 服务共享同一个 readiness 工厂；默认启用两个 descriptor，但已知
HTTP endpoint 会在 secret provider 或 adapter probe 之前被阻断。响应不返回 endpoint 或
secretRef，避免状态页成为凭据和内部拓扑泄露面。

## 验收边界

fixture 用于验证去重、分页、租户隔离和 Watchdog 投影，不替代生产证据。真实验收必须记录
provider/tenant、sourceRevision、observedAt、cursor、限流、失败恢复和数据口径，并证明相同事实
重放不会重复生成 Action/Task/Audit。
