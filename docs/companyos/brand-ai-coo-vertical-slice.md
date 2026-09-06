# Brand AI COO vertical slice

本模块是 Issue #17 的第一阶段实现，位于 `packages/server/src/modules/company_os`，不进入 `packages/core` runtime kernel。

## 复用与边界

- `organizationId`、授权和现有 integration adapter 作为真实接入边界；本模块不复制账号/租户系统。
- `InMemoryEventBus` 只用于纯领域测试；`DurableCompanyOsEventBus` 使用企业数据库中的事件与 consumer receipt 表，处理成功后才确认，重启后不会重复投影已确认事件。
- `/enterprise/companyos/*` 路由复用企业账号与管理员 principal；组织范围只取服务端身份，不接受请求体覆盖。
- `BrandWatchdog` 只产生有证据的建议；`DurableCompanyOsActionExecutor` 只执行已人工批准且通过运行策略的 Action，并要求注入真实 connector。
- Owl/知了猴的事件通过 `CanonicalEvent` 投影进入；未配置 connector 必须返回 unavailable/blocked，而不是成功。

## 已完成

- Canonical money/freshness/event/action/audit contracts。
- Profit Engine v1：整数金额、成本缺失时 unknown、SKU 维度汇总、贡献利润率。
- 去重事件发布与按 consumer 的 at-least-once 消费语义；重复幂等键若对应不同事实会明确冲突。
- Watchdog `event → recommendation → evidence-linked action → audit`。
- CEO Brief 的 Revenue/Margin、风险、机会、建议/执行/待决策分栏。
- Profit Engine 拒绝混租户输入，事件消费键包含 organizationId，避免相同外部事件 ID 跨租户碰撞。
- SQLite schema 29 与 PostgreSQL migrations 15-17 包含组织级事件、最新事实、consumer receipt、claim/lease 和 Action execution receipt 数据契约。
- SQLite 持久化 Watchdog Action/Task/Audit 投影，Task 只进入 `pending_decision`，事务提交后的重放依靠稳定 ID 和唯一约束保持幂等。
- SQLite consumer 原子领取单条事件；活跃租约阻止并发 worker 重复处理，过期租约允许更高 fence token 接管，旧 worker 不能再确认或提交 Watchdog 投影。
- 认证 HTTP 路由支持事件写入、租户级 Watchdog 检查、Action/Task 查询和管理员 Audit 查询；管理员触发检查不会处理其他租户事件。
- 集群模式使用独立异步 PostgreSQL authority，不回退 SQLite；通过 `FOR UPDATE OF event SKIP LOCKED` 领取事件，并在独立事务内重新校验 owner/fence/租约后原子写入 Action/Task/Audit/Receipt。
- clustered server 挂载与本地模式同等的 CompanyOS 认证路由，组织范围来自 PostgreSQL 会话或管理员 principal。
- 本地与集群模式都要求管理员显式批准或拒绝 Task；批准只把 Action 置为 `queued`，拒绝置为 `rejected`，重复同一决定幂等、冲突决定返回错误，并写入 human Audit。
- 本地认证路由提供显式 Action execute/reconcile 边界：管理员、人工批准、运行策略和已安装 connector 缺一不可；provider 明确回执才标记 executed，异常或租约过期进入 `unknown_outcome` 并停止自动重放，显式 reconcile 后才可完成。
- Action execution 以租户和 Action 派生稳定幂等键，持久保存 provider、操作指纹、worker/fence/lease、脱敏错误和 provider receipt；成功时同一事务完成 Action、Task 与 Audit 投影。
- `BusinessDataConnectorV1` 定义 capability/schema version、冲突策略、限流、HTTPS、opaque secretRef、readiness 和同步 cursor；猫头鹰/知了猴 descriptor 与 fixture 已加入，但 fixture 固定为 `fixture_only`，不能作为生产 ready 证据。
- 本地与 clustered 成员可从 `/enterprise/companyos/connectors` 查看本组织 readiness；默认猫头鹰/知了猴 HTTP endpoint 明确返回 `blocked/insecure_endpoint`，响应不暴露 endpoint 或 secretRef。
- Inventory Engine 以整数单位和单位成本计算库存金额及 28 日覆盖天数；缺成本、缺需求或有库存但零需求时返回 partial，不把未知周转包装成正常。
- Cash Engine 以整数金额计算净营运资本、现金 runway 和逾期应收比例；缺经营流出或流出为零时不生成有限 runway，负现金作为风险显式呈现。
- Growth Engine 分开计算收入与贡献利润增长，并保留归因假设；收入上涨但贡献利润下降时只报告风险，不包装成健康增长。
- 三个经营引擎都拒绝跨组织、跨币种、负数经营输入，聚合 source/sourceRevision/observedAt/evidenceRefs，并将过期数据标成 stale 风险。
- 本地 SQLite 与 clustered PostgreSQL 都提供认证的 `/enterprise/companyos/brief`；只读取当前成员组织的版本化持久经营事件，使用最新业务事实生成 Revenue/Margin/Inventory/Cash/Growth 五指标。
- Brief 金额统一输出十进制字符串以避免 JSON/JavaScript 精度损失；缺失不归零、过期时整体降级、坏事实隔离并暴露 evidence id，历史查询超过 10,000 条时 fail closed，等待后续持久 projection 压缩。
- 共享 desktop renderer 增加企业专属、按需打开的经营简报工作页，并通过 preload IPC 与 main 进程企业客户端读取 Brief；会话令牌不进入 renderer，个人版隐藏该模块，加载失败不伪造指标。
- 覆盖租户隔离、重复/冲突事件、缺成本、价格/GMV 异常和持久化重放的确定性测试。

本地交付提交：`9002108a` 恢复原 PR #19 纵切，`932a3641` 补齐上述租户与幂等完整性门禁。

## 未完成与下一步

- 在真实 PostgreSQL 实例执行 migration、并发多副本 claim/超时接管与重启恢复验收；当前 mock SQL 测试不替代真实集群证据。
- 将 PostgreSQL migration 17 接入 clustered Action execute/reconcile repository 与路由，并在真实多副本环境验证 Action lease/fencing/receipt/reconcile；当前 SQLite 路径和 PostgreSQL schema 不能替代该证据。
- 猫头鹰/知了猴真实 API adapter、HTTPS、租户授权、secret provider 与 live readiness/sync cursor；在这些外部条件完成前，执行路由保持 connector unavailable，不能伪装成功。
- 将经营简报接入 Tauri/Rust 企业认证通道并完成最终安装包用户路径；当前 Electron compatibility main/preload 桥不等于 Tauri 发布验收。
- 预测校准、真实猫头鹰/知了猴 OAuth/API 连接。
- Desktop 首页与真实 Design Partner 验收；当前 fixture 和纯领域测试不替代 live/production 证据。
- 下一阶段应在真实 PostgreSQL 上验收异步 repository，再把 action 执行接到 policy/approval/workflow/audit 的真实持久路径。
