# Agent Note: Obsidian 兼容知识库 v2

Status: proposed

[English](2026-09-22-obsidian-compatible-knowledge-vault-v2.md) | 中文

## Problem

Issue #32 要求 ClawMaster 将记忆、笔记与知识图谱建设成可与 Obsidian 对照的、由用户拥有的知识产品。任务书中 2026-09-22 的描述来自旧版本或 不完整的运行态观察：当前源码已经提供本地 Markdown Notes vault、 frontmatter、标签、每日笔记、wiki 链接跳转、反向链接、确定性文本检索、 可审阅的 agent 提案、批注，以及覆盖笔记正文和可选 OpenViking 记忆的 派生 Graph Memory 索引。

剩余差距依然明显。Notes 检索会扫描 vault，Graph Memory 会完整重建一份 JSON 快照，侧边栏只展示主题和相似项而不是真正可导航的关系画布， `.canvas` 只能只读打开，同时也没有产品内同步、恢复时间线、模板系统或 从旧 `memory.md` 迁移的能力。若把这些差距误判成“基础能力不存在”，将会 再造一套 vault 和图谱，而不是完成用户已经拥有的产品。

## Proposal

保留现有 Notes vault 作为唯一可由用户编辑的事实源。将 Graph Memory 演进为该 vault 与可选只读记忆源的可删除、可重建、带版本索引。Session 数据库继续作为运行历史事实，绝不迁入 vault，也绝不改名。

本提案扩展而非立即取代已经实现的 [Notes vault](../../implemented/feature/2026-09-13-clawmaster-notes-vault.zh.md) 与[统一图谱检索](../../implemented/architecture/2026-09-14-graph-memory-unified-retrieval.zh.md) 决策。只有评审确认下述所有权、迁移和 OpenViking 选择后，才开始实现。

## Verified baseline and corrected gap matrix

基线来自 `main` 的 `5566bec` 源码与包级测试。Notes 通过 187 项测试，另有 4 项平台跳过；Graph Memory 14 项全部通过；D2 session 套件 77 项全部 通过。D7 浏览器交接回归仍可复现为 HTTP 400，直到测试 HTML 补上 CSP nonce 注入要求的 `<head>`。

| 维度 | 当前源码 | 剩余差距 | 优先级 |
|---|---|---|---|
| 可移植存储 | 可配置、位于运行时目录外的本地 Markdown vault | 旧 `memory.md` 导入及显式 vault 选择/迁移 | P0 |
| 链接与反链 | wiki/标准 Markdown 链接、真实反链、缺失链接创建 | 持久增量链接索引与未解析链接浏览器 | P0 |
| 图谱 | 类型化节点/边、证据、主题、相似关系、未解析链接 | 交互式全局/局部图谱画布及笔记跳转 | P0 |
| 可靠性 | 修订保护原子写、提案、审批、D2 追加修复 | 恢复快照、回收站与现场连续观测 | P0 |
| 检索 | 确定性有界标题/正文检索与图谱 BM25 | 增量 FTS5、摘要、过滤器与过期代际处理 | P1 |
| 组织 | frontmatter、标签、嵌套目录、每日笔记 | 属性 UI、模板、MOC、书签与大纲 | P1 |
| 同步/版本 | 普通文件可由外部 Git 或同步工具管理 | 产品恢复 UI 与同步冲突策略 | P1 |
| 用户主权 | 编辑/删除/重命名、差异审阅、审批、来源批注 | 可恢复删除与逐次变更历史 | P1 |
| 编辑体验 | 编辑/预览模式与安全 Markdown 渲染 | 实时预览、大纲、多光标、可编辑 Canvas | P2 |
| 扩展 | DSH 工具与插件组合 | 不承诺兼容 Obsidian 社区插件 | P2 |

当前 `graph.sqlite` 只有一条 KV 记录并不表示图谱为空：Graph Memory 有意 通过 `ctx.storage` 原子替换一份通过校验的完整图谱快照。但这确实是扩展性 限制，因为每次刷新都要替换整份快照。

## Defect disposition from the task brief

- **D2 已在 `main` 实现。** `Session.append` 会快照旧注入载荷、补齐缺失的 消息身份字段并校验最终 surface event。聚焦 Session 套件 77 项全部通过。 连续七天 `session-doctor` 现场观测仍属于运维证据，本提案不能把它冒充为 已完成的代码成果。
- **D7 仍可复现。** browser-open fixture 缺少 `<head>`，因此生产 CSP nonce 渲染器正确地以 HTTP 400 拒绝。当前分支把 fixture 修成与发布文档结构 一致的 HTML，聚焦浏览器交接测试现已返回 200。
- **D9 描述的不是当前源码树。** 点名的 `scripts/tests/*.test.js` 及其覆盖的 企业/E2EE 实现位于独立 `dsh-workline` 快照，不在当前 `main`。当前 `main` 只有 `scripts/tests/*.spec.ts`，并已被 `scripts/**/*.spec.ts` 匹配。只复制 测试而不复制其产品源码会制造虚假红色门禁；该快照需要单独做历史/导入 决策。
- **D12 已在 `main` 实现。** 仅本地开放的 runtime-health 路由和首页层会 展示被禁用的插件名，同时不向共享部署泄露主机细节；原生 rescue 也会记录 禁用名称。逐插件功能探针仍明确不属于该功能契约。

## Ownership and storage

`@clawmaster/dsh-notes` 继续拥有所有 Markdown 与 `.canvas` 文件、修订 校验、提案、批注及经用户批准的修改。vault 始终是 Obsidian 无需转换即可 打开的普通目录。ClawMaster 的私有派生状态只能放在 `.clawmaster/` 下， Obsidian 可以忽略，用户也可安全删除。

`@clawmaster/dsh-graph-memory` 不拥有任何用户内容。它只拥有位于 vault 之外、可重建的 SQLite 索引。每个已提交代际包含：

- `pages(path, title, hash, mtime_ms, properties_json)`；
- `links(src_path, target, resolved_path, kind, evidence)`；
- `entities(id, name, type, source_path)` 与 `mentions(entity_id, source_path, start_offset, end_offset)`；
- `relations(src_entity, dst_entity, kind, evidence_path, evidence_start, evidence_end, producer, review_state)`；
- `pages_fts`，覆盖标题、路径、属性和 Markdown 正文的 FTS5 外部内容索引。

每条关系必须保留人可查看的证据。规则产生的链接与 frontmatter 实体可因 可复现而自动发布；模型产生的实体与关系在人工接受前只能是提案。接受后 先写入可见 Markdown/frontmatter，再由派生索引观察到它们。

## Indexing and query contract

首次扫描记录内容哈希。后续扫描只用元数据筛选候选文件，只哈希有变化的 候选，只解析变更文件，并原子提交新代际。一次查询绑定一个代际；旧代际 上的分页必须明确报过期，不能混合新旧结果。

搜索文本只能作为数据，不得作为可执行 FTS 语法。结果包含有界摘要、命中 字段、笔记修订号和索引代际。图谱查询与 UI 使用同一组索引节点和边，使 模型与用户不会看到互相矛盾的图谱。

第一版图谱 UI 只读，支持全局/局部模式、类型过滤、搜索、缩放、平移、 选择节点、查看有证据的边，以及从节点打开笔记。它不编辑关系，也不宣称 兼容 Obsidian Canvas。

## Migration and rollout

1. 检测已配置的 Notes vault 与旧 `memory.md`；绝不把 `~/.dsh/sessions/` 作为迁移输入，也不改名其中任何目录。
2. 生成 dry-run 清单，列出每一条拟迁移笔记、链接、冲突与字节数；发现 阶段不改任何源文件。
3. 经确认后，把旧记忆按“一条持久事实一个 Markdown 文件”导入，并写入 `source`、`created`、`updated`、`legacy_source` frontmatter；原文件保留， 直到以后另行明确清理。
4. 从可见文件构建派生索引，并把数量、哈希、反链、未解析链接与搜索命中 同清单核对。
5. 新搜索/图谱 UI 先在一个版本内通过可逆配置开关启用；现有扫描检索与 快照图谱作为回退路径。

上线期间 OpenViking 只作为可选、只读的语义来源；它不是事实库，也不能 写 vault。完成两周可测量的召回评估后，只有当它能补充确定性 vault 搜索 漏掉且最终被接受的结果时才保留；否则从桌面默认包清单移除，仅保留明确 启用的第三方集成路径。

## Alternatives considered

**在 ClawMaster Notes 旁另建 vault。** 这会重复内容所有权、反链、审批与 迁移。现有 Notes vault 已满足本地优先边界。

**把 session 数据库作为知识事实源。** Session 是追加式运行历史，并有严格 的路径/头部身份约束。编辑或改名会重演 D1/D2 损坏，也不会得到可移植的 知识文件。

**只把模型实体存入 SQLite。** 用户无法在 Obsidian 中审阅或修改这些事实， 删除索引还会丢失知识。因此，接受后的事实写入可见文件，SQLite 只做派生。

**以 OpenViking 为主存储。** 默认禁用的外部服务无法保证确定性离线写入和 用户所有权。它可以增强召回，但不能取代 vault。

**承诺完全兼容 Obsidian。** 社区插件、Dataview 语义和可编辑 Canvas 是 独立产品。兼容契约仅限普通目录、Markdown/frontmatter、wiki 链接，以及 不破坏内容的私有元数据。

## Acceptance criteria

- Obsidian 可打开同一 vault 并编辑每一条用户笔记，无需导出或专有转换。
- 修改一条笔记时，增量刷新只重新解析该条内容；删除并重建索引后，节点、 链接与 FTS 命中保持一致。
- wiki 链接、Markdown 链接、反链、未解析目标、标签和属性都有确定性 fixture，覆盖 Unicode 路径与重名标题。
- 搜索返回有界摘要，并拒绝已过期索引代际的分页。
- 图谱视图渲染真实节点和边，支持全局/局部导航并能打开选中笔记，在文档 规定的节点上限内仍可用。
- Agent 写入继续先提案、修订保护、审批门禁并记录来源；模型生成的图谱 事实绝不静默提交。
- 迁移具有 dry-run、冲突、中断、重试和回滚测试，且绝不写入或改名 session 目录。
- 英文/中文文档、配置目录、包级测试、安装版桌面 smoke test 与端到端演示 全部通过后才上线。

## Risks

增量索引会增加 schema 迁移与过期代际处理复杂度。FTS5 的中文分词行为必须 明确记录，且不能宣传为语义检索。在两个应用同时打开同一 vault 时，仍有 协作锁之外的文件系统竞争，因此必须保留冲突内容。大型图谱布局可能不可读， 渲染必须设上限，但查询结果不能被静默丢弃。恢复时间线会占用存储，需要 明确保留策略。OpenViking 评估不得把私有 vault 内容发送给未经批准的远端。
