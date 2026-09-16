---
description: "面向 Tauri 前端组合包用户与维护者的 ClawMaster WatchDog 桌面工作台、本地数据处理、CRM 与库存订单说明。"
kind: "package-bundle"
---

# ClawMaster WatchDog 前端

[English](README.md) | 中文

## 概述

ClawMaster 在同一个 Tauri 桌面工作台中提供任务、文档编辑、网页浏览、终端与本地业务记录，口号为“开启AI时代的企业协作”。桌面默认包含本组合包，并由 DSH 负责对话、模型、工具、审批、插件和会话恢复。AI 通过 DSH 工具处理 CSV、查询和整理客户与订单；界面用于查看结果、审批及人工接手。AI 任务复用已配置的 DSH 提供方，手动操作不调用模型。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

使用 ClawMaster Tauri 桌面应用。运行环境准备程序包含本前端及[桌面默认组件](../../apps/desktop-tauri/README.zh.md#architecture)中列出的插件。[桌面指南](../../apps/desktop-tauri/README.zh.md)负责安装器、运行环境准备与启动说明；本前端包本身不是桌面安装器。

<a id="first-run-tutorial"></a>
### 首次使用教程

没有 Session 或工作空间历史时，WatchDog 以“本周客户跟进与交付风险巡检”教授五步管理流程：确定范围、写清分工与验收标准、核查 CRM/ERP 记录及提供的文件、选择巡检频率并复核审批，再验证结论、跟进整改。业务草稿分别保存负责人、期限和验收项。主按钮进入 WatchDog 管理台；模型与 IM 设置作为末尾的辅助入口。阅读、跳过或重看均不创建任务，也不会发送提示词或外部消息。已有用户可随时打开“设置 → WatchDog 教程”。

跳过和完成会通过 DSH 设置记录版本化确认，桌面重启或本地端口变化后仍然保留，较新的确认版本不会被降级。写入被拒绝时，教程保持打开并显示重试提示。远程浏览器只在本次设置外壳存续期间保留确认。读完教程不代表 API Key 已验证，也不会创建任务、安排提醒或连接 IM 账号。

### 启动任务或打开工具

应用启动时不创建默认工作空间。没有会话或工作空间历史时，首次进入会打开 WatchDog；已有选择和后续导航优先。启动 WatchDog 任务会在 `$DSH_HOME/watchdog-workspaces/tasks/<uuid>` 下分配目录，并使用 DSH 的常规会话流程。打开编辑器、浏览器或终端时优先使用当前未归档会话；没有可用会话时，首次工具请求才分配 `$DSH_HOME/watchdog-workspaces/desk`，并创建或复用其会话。这些目录和文件会在应用重启后保留。

在设置、组件与 Session 之间切换时，WatchDog 保留任务说明与巡检频率。提示词发出后，受理结果未确认时保留目标 Session，并锁定目标与频率。可重试原请求，或打开原 Session 核查；重试复用相同提示词与请求标识，即使界面语言已切换。发出请求前失败仍可编辑草稿。确认受理后清空草稿并解锁。刷新页面或退出应用会丢弃尚未受理的任务草稿。

工具栏仅报告界面与应用服务的连接，不代表模型可用、调度在线或业务成功。管理台首先显示持久业务任务，优先排列待验收、失败和逾期事项。建立草稿时分别填写目标、范围、负责人、期限、风险和验收标准；也可显式选择旧会话作为来源。保存后可以调整定义、安排执行并关联已有 DSH Session，关联操作不重复发送模型请求。处理中可记录等待条件、失败或提交证据；人工填写意见后验收或驳回，关闭的任务可重新打开。历史分页保留先前提交和验收。证据引用显示为未核实，需人工打开来源核对。

业务保存通过修订号防止覆盖他人修改。列表刷新保留当前打开的详情修订；冲突后必须重新打开并核对。保存结果不确定时暂停其他写入，重试原命令和幂等标识；切换面板保留待确认请求，刷新整页或退出应用后需查看持久记录再继续。下方会话列表优先显示等待审批、回答或计划复核的 Session，并可筛选待处理项。打开原 Session 作出回应。“运行中”和“空闲”表示执行活动，均不证明业务目标已经完成。

手动选择工作空间目录时，点击工作区标题栏的**添加工作区**。目录浏览器在 ClawMaster 窗口内打开，可逐级浏览、直接输入路径或新建文件夹，再点击**打开**使用选中的目录。

WatchDog 位于主区。Better Sidebar 在会话右侧的标签页中打开文档编辑、网页浏览、CRM 和 ERP，在底部打开终端。CRM 和 ERP 与其他组件一起在“设置 → 侧边卡片”管理，各组件的功能设置可打开其右侧标签页。组件默认启用，仅在请求时打开；再次打开已存在的组件会选中其标签页。

访问 WatchDog 等全局面板时，当前 Session 右侧的编辑器和浏览器实例继续保留，包括未保存正文和 iframe 文档。隐藏的停靠与浮动内容不占框架列宽或键盘焦点。切换 Session、关闭 tab 或退出前请先保存。[桌面兼容补丁](../../apps/desktop-tauri/README.zh.md#architecture)还按原生 Session 与 tab 身份保留浏览导航，但不持久保存编辑器草稿。

| 模块 | 用途 |
| --- | --- |
| 文档 | 编辑文本和代码，预览会话工作空间中的文件。 |
| 浏览器 | 在 Better Sidebar 的沙箱浏览面板中打开网站。 |
| 终端 | 使用关联到会话工作空间的终端。 |
| CRM | 维护联系人、公司、阶段、下一步行动和跟进日期。 |
| ERP | 维护 SKU、库存、补货线、供应商及采购/销售订单。 |

### 让 AI 使用业务组件

在任务中描述目标，并把需要处理的文件放入该任务的工作空间。例如：“清理 customers.csv 的空白与重复记录，保存 customers-clean.csv，再查询 CRM，整理需要跟进的客户。”AI 直接调用内置业务工具。CRM 和 ERP 组件提供复核及人工操作，文件编辑器可打开 CSV 结果。数据处理不设置独立面板或导航入口。

### 处理 CSV 或 TSV 数据

让 AI 按明确的分隔符、表头、去除首尾空白、去重、删除空记录、子串筛选和排序规则处理工作空间文件。解析保留单元格文本，包括前导零。引号错误或列数不一致会阻止处理与输出，直到原始数据修正。

工具默认输入上限为 16 MiB，结果预览最多显示 10 行。保存的 CSV 包含全部处理结果，并附带 UTF-8 BOM。电子表格公式保护默认开启，会在可触发公式的单元格前添加单引号。DSH 在会话中记录工具结果和保存的文件路径。

### 保存联系人、库存与订单

CRM 和 ERP 使用 `$DSH_HOME/watchdog/enterprise.sqlite` 中的空数据库开始工作。已保存记录不依赖浏览器来源、Host 随机端口或所选会话。联系人和 SKU 的编辑与删除会记录审计信息。已有浏览器 `localStorage` 记录既不会被删除，也不会自动导入 SQLite。

以草稿保存带数量和单价的采购或销售订单。提交采购订单增加库存，提交销售订单扣减库存。所有明细、订单状态、版本号以及变更前后的审计信息在同一事务中提交。库存不足时整笔提交回滚。已提交订单不能修改、删除或重复生效。

库存与数量使用安全整数，金额使用人民币最小货币单位的整数。订单引用的 SKU 不能删除。不支持、属于其他应用或已损坏的数据库会报错，不会自动重置。

联系人、库存和订单表单按开始编辑时取得的版本保存。共享记录刷新会保留输入，版本变化时展示当前值；明确确认已核对并要保留整份草稿后，才可继续保存。此操作不会自动合并字段。原记录被删除或订单已提交时，不能继续编辑。版本变化会使删除或提交确认失效，需要取消并重新打开后再操作。结果不确定的保存保留命令标识，供用户明确重试。
库存与数量使用安全整数，金额使用人民币最小货币单位的整数。订单引用的 SKU 不能删除。其他视图修改记录后，基于旧版本保存会返回版本冲突：刷新记录、核对当前值，再重新保存。不支持、属于其他应用或已损坏的数据库会报错，不会自动重置。CRM 和 ERP 标题栏提供“下载本机数据备份”，在同一 SQLite 事务中读取完整业务快照和命令回执。此导出仅包含企业记录，不包含会话、Skills、配置档或其他 DSH 主目录数据。

恢复需要选择已校验的备份，复核记录数量，并确认当前 revision 和恢复代次 generation。Host 在写事务中检查这两个值，每次恢复都递增数据库本地的恢复代次；备份不能降低该计数。即使业务 revision 重复，旧写入、审批结果、分页请求和恢复确认仍会失败。Schema 1 数据库通过 schema 2 迁移增加此计数，不替换业务记录。未提供 generation 的旧请求仅属于代次零。浏览器拒绝重叠修改，并忽略恢复之前发起的读取。恢复响应丢失或无效时，进一步写入会被阻止，直到显式刷新读取数据库；系统不会自动重复恢复。

恢复前打开的表单和确认保留原恢复代次。输入仍然可见，但刷新或编辑不会授权它们写入恢复后的记录。表单草稿可在明确复核当前记录后保留，也可取消并重新打开。删除与提交确认必须重新打开。

Schema 3 迁移新增业务快照以外的责任历史。业务写入和恢复成功记录在同一事务中提交；审计失败会阻止写入。恢复旧备份仍会保留备份之后变更的责任记录。记录包含 Host 生成的操作者、传输来源、Session/调用、审批引用、策略版本、修订、结果和备份摘要，不包含联系人或订单正文。从 schema 1/2 导入的历史回执明确标记操作者未知。已认证的 `/api/clawmaster/enterprise/responsibility` 路由提供最多 500 条的分页，可按操作者、命令、对象或操作筛选。恢复请求提供 `commandId` 后，完全相同的重试具有幂等性。仅追加触发器和校验的哈希链能检测本地不一致；机器管理员能够替换数据库，因此企业留存需要独立可信归档。责任历史不会自动删除，也不包含在可移植的业务备份中。 已认证调用者的授权失败及任务失败只记录操作元数据和固定原因码；审批拒绝、取消与失败分别保存。缺失、未绑定或来自其他组织的身份不会被归为本地真人。

数据库创建和升级将表结构变更、组织绑定、历史导入及版本号在同一事务中提交。组织变更被拒或完整性检查失败会回滚该事务；schema 1 数据库迁入企业空间被拒后，仍可按本地模式打开。

### 业务任务与身份接口

Host 选项 `watchdogTasks.maxResponseBytes` 设置完整任务响应的 UTF-8 字节预算，包含 DSH 结构化值和渲染文本；默认 65536，接受至少 1024 的整数。超预算的写入在提交任务、历史行或成功回执前失败。列表依次优先显示待验收、失败、逾期及其他任务；每页返回 `{ tasks, nextCursor }`。继续读取时原样传入 `cursor`（HTTP 中使用 JSON 编码），保持同一集合版本及紧急程度判断时间；写入后旧游标返回 `revision_conflict`。历史返回 `{ tasks, nextAfter }`：传入 `id`、`history=true`、`after` 和 `limit` 继续读取不可变修订。两种分页都可能为满足字节预算而少于请求数量。浏览器只保留一页任务和一页历史；刷新列表或重新读取历史回到第一页，不推进已打开任务的修订。已有记录超限会明确返回 `response_too_large`（HTTP 413），不会截断或改写数据。浏览器与 Host 共享 [watchdog-task-format.ts](src/watchdog-task-format.ts) 中不依赖 Node 的校验。

`watchdog_task_query` 和 `watchdog_task_command` 管理持久任务，包含负责人、期限/时区、风险、范围、验收项、证据和关联 DSH Session。业务状态包括草稿、待执行、处理中、待验收、验收通过、失败和取消。等待与逾期标记独立于 Session 活动。代理提交证据，不能验收、重新打开或取消任务。人工驳回使任务回到待执行，同时保留以往证据和验收历史。命令携带任务修订和幂等标识；显式导入 Session 只创建草稿，不会推断历史成功。`/api/clawmaster/tasks` 可读取分页、一个 `id` 或其 `history=true`；`/api/clawmaster/tasks/command` 接收共享命令信封。这些记录不参与 CRM/ERP 恢复。人工检查位置前，证据引用明确属于未核实状态；Host 不会抓取任意证据 URL。

本地模式标识设备操作者，使用明确标记的本地负责人。嵌入式 Host 可通过 `src/governance-access.ts` 中的可信 `GovernanceAuthority` 接口配置 `governance: { mode: 'enterprise', organizationId, authority }`。该权威服务必须独立于 DSH 桌面令牌认证 HTTP 请求，将代理 Session 绑定至发起成员，每次操作读取当前成员权限，并消费绑定对象/修订/摘要的审批。每个数据库绑定一个组织；已有本地数据库不能静默转为企业数据。HTTP 与工具消费者检查相同的角色与资源授权，审批等待后也会重查。委派授权不能超过发起成员的权限。每次企业记录变更、任务写入和恢复都需要另一名有效审批者；任务结果由有权限的人工直接验收，提交结果的成员不能自行验收。已提交任务的重试仍检查当前权限及完全相同的调用者和内容，不再消费另一份批准。权威服务不可用时操作失败，不会回退到本地权限。

企业概览包含版本、集合数量和已配置的分页上限，需要组织范围的记录与审计读取权限。所有 HTTP 写入仅返回命令回执元数据，本地桌面模式也相同。仅获部分资源权限的读取者使用 `/api/clawmaster/enterprise/query` 或 `enterprise_query`，传入有权限的记录 ID；审计读取需要独立权限。

| 角色 | 允许的操作 |
| --- | --- |
| 管理员 | 读写记录和任务；导出、恢复、查询审计；人工验收任务 |
| 执行者 | 在获授权资源内读写记录与任务 |
| 审批者 | 读取记录/任务、验收任务结果；批准精确的企业命令 |
| 审计只读 | 读取记录/任务、导出备份、查询责任元数据 |

权威接口是集成要求，不是内置身份提供者，也不代表已验收的多人部署。组织登录、身份提供者接入、附件服务、显式本地到企业迁移和真实桌面验收流程仍需按部署完成集成。外部 CRM/ERP 连接器是独立能力。

### 使用提醒与即时通信连接

组合包启用 DSH 官方 Schedule、时间上下文和提醒目录。提醒送达需要应用保持运行，且所属会话中有活动的根 agent（智能体）；关闭应用不会创建操作系统后台调度程序。到期提醒在该会话可以接收时返回原对话。支持的定时方式与恢复行为见 [Schedule 指南](../../docs/user/guide/schedule.zh.md)。

即时通信账号设置与平台登录流程由内置 IM 插件负责。包含该插件并不代表已经连接飞书、微信、企业微信或钉钉；各平台的账号条件和连接结果需要在其设置中实际核验。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现与贡献者检查——点击展开</summary>

侧栏与对话欢迎区通过客户端构建的 SVG data URL loader 渲染透明的[浅色 SVG](src/clawmaster.svg) 或[深色 SVG](src/clawmaster-dark.svg)。CSS 跟随 DSH 解析后的 `body[data-ds-dark-theme]` 状态，包括手动选择主题与跟随系统模式。[桌面资源指南](../../apps/desktop-tauri/README.zh.md#release)负责启动页、favicon 与原生图标分发；[PNG](src/clawmaster.png)仅保留为视觉参考。

[Profile 补丁](cordis.patch.yml)禁用官方品牌与自适应目录选择行，插入本前端及 DSH 的目录浏览后端与界面，启用 Schedule 与时间上下文，并开启提醒界面。DSH Web 组合包已提供这两个目录浏览软件包。[客户端入口](src/client.tsx)使用 DSH 现有的 slot、主题、会话、工作空间与面板服务。[Host 入口](src/host.ts)在已有、带认证的 DSH Fetch 传输层注册惰性工作空间分配和企业路由，不启动第二个服务。

[PapaParse 处理代码](src/business.ts)负责 CSV 语法与序列化。[企业存储](src/enterprise-host.ts)使用 Node SQLite 和事务；HTTP 路由与 [AI 工具](src/enterprise-tools.ts)共用存储、命令校验和版本检查。DSH 设置存储仍用于配置。企业数据不会自动进入模型。[企业决策记录](../../.agents/notes/implemented/bug-fix/2026-09-13-enterprise-reviewed-writes-and-bounded-queries.zh.md)说明审批归属、已复核版本与定向读取；[WatchDog 请求决策记录](../../.agents/notes/implemented/bug-fix/2026-09-13-watchdog-task-admission-and-attention.zh.md)说明草稿生命周期与待处理交互投影。

浏览器与 AI 查询选择一个 SQLite 集合，绑定筛选参数并在 SQL 中分页。忽略 Unicode 大小写的字面搜索覆盖文本列和订单物料 ID；审计搜索还包含持久保存的变更前后 JSON。匹配计数可能扫描所选集合。排序与关联索引避免在搜索时构造全部 JSON；无筛选审计续页按有索引的修订区间读取。启动通过迭代校验每条记录、审计修订、引用和责任哈希，不构造完整快照。审批准备只读取目标与关联库存；所有普通保存和重试均返回单条持久回执。

`GET /api/clawmaster/enterprise` 返回 `{ generation, revision, counts, limits }`；`/query` 接收 `collection`、`offset`、`limit`、两个版本字段，以及可选的 `id`、`search`、联系人 `stage`/`dueBefore`、库存 `lowStock` 或订单 `kind`/`status`。分页返回 `{ generation, revision, collection, offset, total, nextOffset, records }`。每次续页必须携带两个版本；编辑或恢复后返回 `revision_conflict`，不会混合不同数据集。浏览器为每个可见列表保留一页，另行查询页外编辑对象与 SKU 候选。保存先验证回执再刷新计数；刷新失败不撤销已确认成功。分页和新提交的审计条目都受完整记录字节上限约束：超限变更回滚并返回 `result_too_large`（HTTP 413）。已有超限数据原样保留，需要提高读取预算后访问。

Host 插件通过 Cordis 配置接受以下可选设置。存储路径必须为绝对路径。

| 设置 | 默认值 |
| --- | --- |
| `managedRoot` | `$DSH_HOME/watchdog-workspaces` |
| `databasePath` | `$DSH_HOME/watchdog/enterprise.sqlite` |
| `busyTimeoutMs` | `5000`；SQLite 写锁等待时间，范围为 `0` 至 `60000` 毫秒 |
| `dataTools.maxInputBytes` | `16777216` |
| `dataTools.previewRows` / `previewColumns` / `previewCellChars` / `maxDiagnostics` | `10` / `8` / `120` / `10` |
| `enterpriseTools.maxQueryRows` / `maxQueryBytes` | `100` / `262144` |
| `enterpriseRead.maxPageRows` / `maxPageBytes` | `50` / `262144`；浏览器行数上限 ≥ 1，UTF-8 字节上限 ≥ 1024 |

在已准备好仓库支持的 Node 运行时和本包依赖后，在本目录执行以下命令：

```sh
npm run typecheck
npm test
npm pack
```

测试命令先构建客户端 factory 和 Host bundle，再执行本包的定向测试。打包时会运行相同构建并生成本地 `.tgz`；本包为 private。React 与 React DOM 来自 DSH 的共享客户端运行时。工具导航先提交会话视图，再打开面板，确保 DSH 面板挂载点已绑定。[桌面构建](../../apps/desktop-tauri/README.zh.md)把前端产物包含在运行时资源中。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [桌面安装与运行时](../../apps/desktop-tauri/README.zh.md)——Tauri 打包、启动与平台行为。
- [Profile 组合](../../packages/boot/app-boot/README.zh.md)——DSH 组合包顺序与配置。
- [官方 Schedule](../../packages/schedule/schedule/README.zh.md)——持久提醒与活动会话内送达。
- [企业记录与命令](src/enterprise-types.ts)——客户端和 Host 共享的数据定义。

-----

<a id="model-experience"></a>
## 模型体验

前端通过 DSH 常规工具流程注册 `csv_process`、`enterprise_query` 和 `enterprise_command`。CSV 工具读取当前 Session 工作空间内的完整文件，返回有上限的预览与统计，并可保存全部处理结果。覆盖已有文件需要先读取，并通过 DSH 文件版本保护。写入提权使用常规 DSH 单次审批，获准后路径仍不得超出工作空间。

企业查询返回带版本号、匹配总数和继续偏移量的有界分页。分页拒绝过期版本，单条记录超过字节预算会明确失败。AI 每次新的业务写入都需要 DSH 显式单次批准，包括保存联系人和订单草稿。审批被拒绝、取消、不可用或策略为 `never` 时，记录保持不变。版本冲突要求重新读取；相同已提交命令仅向同一经过认证的组织、参与者类型/ID 和发起主体返回原有回执，不重复写入或审批。重试保留完整的已审阅命令信封。没有归属记录的回执（包括从备份导入的审计历史）不能授权重试；发出新命令前必须刷新记录并重新审阅。已认证界面的人工保存保留用户发起行为。界面与 AI 使用同一个本地数据库。

工具调用和返回数据经 DSH 写入 Session 日志及后续模型请求，数据库不会自动复制到提示词中。包内录制的[业务流程](tests/business-tool-flow.test.mjs)使用合成模型覆盖 CSV 到 CRM 的工具结果、CRM 单次审批、持久化重放和 ERP 审批缺席。Schedule 负责提醒工具与后续消息。

ClawMaster profile 为新 Session 选择 DSH `read-only` 文件访问与 `ask` 审批。工作空间文件写入需要显式单次提权；`never` 审批会拒绝需要决定的请求，而不是自动同意。已保存的用户设置优先于 profile 默认值。委派 Session 在模型步骤与工具执行前，将创建时取得的文件访问范围与实时祖先权限取交集；祖先缺失或成环时仅允许读取，子代理审批保持 `never`。DSH 规范 setter 将收紧操作追加到 Session 日志。Agent Teams 默认最多三名成员、一级委派；既有服务负责名单校验，包括 Web 规划路由。

#### KV Cache 影响

`runtime_status` 返回带观测时间的桌面身份与源码来源；壳记录不属于当前 Host 时返回不可用。记录到日志的运行时上下文在请求组装时刷新这些事实，并将记忆中的版本、路径、端口和权限视作历史。前端 Host 行的 `runtimeGovernance` 可配置 `maxRssMiB`（默认取 2048 MiB 与物理内存四分之一中的较小值，下限 256 MiB）、`maxConcurrentHeavyTools`（2）和 `heavyToolPatterns`（Shell、子代理、团队、工作流与 CSV 工具名称）。DSH 单调守卫在 Host RSS 达到预算时拒绝新的匹配工具；执行分发拒绝超额重叠调用，并在成功、失败或取消后释放容量。状态读取仍可用。这些限制不约束外部进程内存、工具返回后的后台工作、Office WebView 或其他应用。

前端增加工具 schema、已记录的工具结果与带时间戳的运行时上下文，不添加独立模型提供方或系统提示词前缀。观测与结果变化影响请求后缀。DSH 负责请求组装与缓存处理。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

以下限制适用于本前端及其本地记录。

- 集成基线为 DSH `0.1.5-rc.2` 与 Cordis `4.0.2`。兼容范围限于本包使用的公开服务和实际测试过的插件组合，不代表所有 DSH 插件均已认证兼容。

- CRM 和 ERP 是本地单用户记录功能，不是多人共享的多租户企业系统或外部 ERP/CRM 连接器。审计历史完整保留。显式备份/恢复仍会实体化完整导出并同步执行，可能占用大量内存并阻塞 Host。[容量实测](benchmarks/README.zh.md)区分有界日常读写与这些操作，不构成无限容量保证。数据处理器支持分隔文本，不支持 XLSX 工作簿或持久化电子表格服务。

- 本包不承诺独立安装器体积。Tauri 壳、DSH、Node 运行时与第三方组件分别具有各自的打包和许可要求；本包采用 Apache-2.0。

- OpenViking Memory 已安装，但桌面默认在连接前保持禁用。[本地服务指南](../../apps/desktop-tauri/README.zh.md#optional-local-openviking-service)负责 macOS 准备、USER 凭据和外置 AGPL-3.0 服务说明；集成插件采用 Apache-2.0。仅有服务健康不能验证桌面记忆捕获或跨 Session 检索。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>开发验证背景——点击展开</summary>

当前检出版本处于桌面集成开发阶段。源码测试和包构建属于开发证据，不能证明新安装桌面、所有模块交互、真实模型提醒或平台扫码登录已通过验收。桌面集成任务负责在发布前完成这些实际检查。

</details>
