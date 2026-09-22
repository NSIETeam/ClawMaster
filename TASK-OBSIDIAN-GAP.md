# TASK-OBSIDIAN-GAP — 记忆·笔记·知识图谱对齐 Obsidian：问题清单与差距分析任务书

> 指派日期 2026-09-22 · 优先级 P1 · 关联：#12（整改总追踪）、#16（D3）、#19（D6）
> 配套 GitHub Issue 为本任务的分派与进度载体；本文件是任务的完整技术底稿。
> 责任人接手前必读：根目录 [AGENTS.md](AGENTS.md)、[docs/STATUS-2026-09-21.zh.md](docs/STATUS-2026-09-21.zh.md)、[docs/DEFECTS-DAWN.zh.md](docs/DEFECTS-DAWN.zh.md)，并执行 `git log --oneline -20`。

## 0. 任务目标

1. 修复第 1 节所列现存缺陷中的认领项（建议顺序 D2 → D7 → D9 → D12）。
2. 核实并修订第 5 节"三系统 vs Obsidian"差距矩阵（实测于 2026-09-22，组件可能演进）。
3. 产出"记忆系统 v2"架构提案（vault 化、双向链接、图谱、检索、OpenViking 去留），先评审后动手。

**硬规则**（违反即坏产品，全部付出过代价）：

- `~/.dsh/sessions/` 会话目录**禁止改名**（头部 id/cwd 与路径强一致校验，改即坏）。
- `harness-versions/` 只读且有完整性恢复（D3）：运行时补丁会被打回，持久修复只进仓库源码或用户层 `~/.dsh/cordis.patch.yml`（应用不会重写它；`~/.dsh/desktop-overlay/cordis.yml` 会被应用每次启动重写回模板，别放东西）。
- **不要与运行中的 ClawMaster App 并发启动 headless/探针进程**：双方都开 `graph.sqlite` 写锁，输方插件被救援禁用且 UI 零提示（D4/D12）。
- 注入上下文的消息必须带 `id/role/source`，缺失产生坏会话（D2）。
- 版本基线：desktop 0.0.1beta（2026-09-21 重置，commit `8daba27c8b`）· DSH 包线 0.1.5-rc.2（harness `72da6c767414dd30`）· 版本决策见 `.agents/notes/implemented/process/2026-09-21-product-version-reset.md`。

---

## 1. 现存问题（2026-09-22 快照）

### 1.1 缺陷登记 D1–D12（来源：docs/DEFECTS-DAWN.zh.md，含代码锚点与验证方法）

| # | 问题 | 代码/环境锚点 | 影响 | 现状 | 根治方向 | 建议验证 |
|---|---|---|---|---|---|---|
| D1 | 会话扫描一票否决：任一坏会话导致全部历史不可见 | `packages/workspace/workspace/src/index.ts`（`WorkspaceRegistry.listStoredHeaders`） | 一条坏会话 → 整个历史面板挂 | session-doctor 自愈兜底 | 逐会话隔离（"每会话=独立插件"）；本地分支已含 `isolate loader entry failures at boot` | 人为注入一条坏会话事件，确认其余 92 条可见 |
| D2 | 上下文注入写 `user/message` 缺 `role/id/source`（技能目录回放 / Graph Memory 召回 / 时间上下文） | `packages/core/session/src/index.ts:363`（`assertMessageEventShape`；调用点 :169、:272） | 持续产生坏会话（D1 的源头） | 运行时读取自愈补丁（会被 D3 回滚）+ 每 30 分钟 launchd session-doctor | **内核修复：`createUserMessage` 默认补齐 role**，写侧与读侧策略对齐 | 修复后连续 7 天 `node ~/.dsh/scripts/session-doctor.mjs` 零新增坏会话 |
| D3 | 运行时完整性恢复：`harness-versions/` 文件恢复 pristine | `~/Library/Application Support/DeepSeek Harness/harness-versions/` | 一切运行时补丁不持久 | launchd 兜底 | 升级 dsh 内核（repo HEAD 已含修复）；升级前任何 chmod u+w 补丁都是徒劳 | 升级后重启两次，`lib/index.js` 补丁存活 |
| D4 | 并发锁冲突：探针与 App 并发持有 `graph.sqlite` 写锁 | `graph.sqlite`（主会话库）；headless profile 启动路径 | 插件被救援禁用 → UI 任务列表清空且无报错 | 操作纪律规避 | 插件加载锁等待/重试 | 双进程并发启动场景自动化测试 |
| D5 | overlay 配置每次启动被重写回模板 | `~/.dsh/desktop-overlay/cordis.yml`（对照用户层 `~/.dsh/cordis.patch.yml`） | 自定义插件丢失 | 自定义放用户层 | 应用保留用户 insert 段 | 写入自定义 insert → 重启 → 仍在 |
| D6 | MCP 桥仅支持 stdio（已有关联 issue #19） | 4 个 ZCode 托管 HTTP MCP（hexin/wind/tianyancha/finance-search，JWT 鉴权） | 金融数据插件无法原生用 | 建议插件市场安装 | MCP 桥支持 http 传输 | 任一 HTTP MCP 插件原生装加载成功 |
| D7 | 浏览器启动 400 回归 | `packages/bundle/web-app/tests/browser-open.spec.ts` | web 启动握手异常 | 未修，单跑可复现 | 排查 token/host 校验变更 | spec 期望 200 恢复绿色 |
| D8 | 版本号硬编码漂移 | `packages/server/src/server.ts:4703-4704`（appVersion/updateCheck） | 版本一致性 | **已解决**（2026-09-22 重置，=0.0.1beta，commit `8daba27c8b`） | 结构性收尾：从 package.json 注入，删除字符串字面量 | 版本一致性门禁进 CI |
| D9 | 孤儿门禁测试：不在任何 vitest include | `scripts/tests/*.test.js`（e2ee-release-readiness、enterprise-caddy-security、enterprise-oneclick-installer、federation-staging-smoke 等） | 发布门禁 CI 根本不跑 | 未修 | 纳入 vitest include（注意与 `.spec.ts` 的现有 include 规则区分） | CI 出现这些测试的结果列 |
| D10 | lint 债：快照目录 6.4 万风格错误（semi/indent 等） | 三个未跟踪快照目录 | `pnpm lint` 全局红灯 | 不阻塞构建 | `oxlint --fix` 批量清理后纳入跟踪或删除 | `pnpm lint` 全绿 |
| D11 | 技能目录选择噪声：134 条目录条目，模型按名字浅匹配 | 技能目录注入（`<available_skills>`）+ `~/.dsh/desktop-overlay/skill-discipline.mjs` | 首次选错技能 | 技能纪律系统段 + 中文触发词（探针 10/10） | 按工作区分域加载技能 | 探针矩阵保持 10/10 |
| D12 | 救援禁用无感知（D4 的表现被放大） | 插件启动失败 → rescue-disable 路径 | 用户不知道功能缺失 | 无 | UI 通知 + 健康面板 | 禁用场景 UI 出现可见提示 |

### 1.2 登记外待办

1. WIP 快照分支 `codex/dsh-desktop-wip-20260919`（604 文件/28.4 万行）缺 6 文件：`native/sqlcipher-tauri`、`tauri-node-runtime.yml`、`browserPreviewBridge.ts`、`css.d.ts`、`security/e2ee-release-status.json`、`sqlcipher-native.yml`——需从 Windows 构建机同步或摘除引用，阻塞完整构建还原。
2. 桌面更新通道未配置：验签公钥已内置（`apps/desktop-tauri`），缺 HTTPS 更新端点；v2 通道协议见 `.agents/notes/implemented/architecture/2026-09-15-versioned-native-update-targets.md`。注意：版本重置为 0.0.1beta 后，已装 0.2.3 客户端视其为降级，不会自动收到。
3. `pnpm run doc-sync` 语料中仍可能有未配对文档新增（本任务新增文档一律按"英文 .md + 中文 .zh.md + .i18n.yaml"三件套提交）。

---

## 2. 过去发生过的问题（避坑清单）

| 时间 | 事件 | 处置 | 教训 |
|---|---|---|---|
| 2026-09-21 前 | F1 微信通道全部回复 `INTERNAL_UNKNOWN` | 环境残留清理 + 会话重置 | 报"工具调度器缺失"先查环境残留，别急着改码 |
| 2026-09-21 | F2 会话库 role 缺失：21 会话/93 事件损坏，历史加载全挂 | `~/.dsh/scripts/repair-session-roles.mjs` 修复；手册 `~/ClawMaster/memory/2026-09-21-session-role-repair-runbook.md`；launchd `com.clawmaster.session-repair` 每 30 分钟自愈 | 写侧不校验，读侧全还债；D2 是同一根因 |
| 2026-09-21 | 27 个企业管理技能 frontmatter YAML 解析失败被**静默丢弃** | description 规范化 + 中文触发词 | 解析失败必须 fail loud，静默丢弃=功能消失 |
| 2026-09-19 | CI run 35422531372 失败，无更新版 | 等待修复后重发 | 红着不能发版 |
| 2026-09-19 | 下载到非官方 `harness-core-20260919.tar.gz`（sha 0256...） | 未采用 | 产物以 repo/updater 验签为准 |
| 2026-09-21 | 原 `NSIETeam/ClawMaster` 仓库删除归档；ClawMaster-Desktop 改名接任唯一远端 | 旧产品线（companyos，208 提交）保存在 tag `legacy/main-pre-dsh`；WIP 快照分支 `archive/clawmaster-wip-20260919` | 删库前先归档分支 |
| 持续 | 会话目录改名导致历史加载失败 | — | 目录名与头部 id/cwd 强一致 |
| 2026-09-22 前 | 版本三线漂移：desktop 0.2.3-fix / DSH 0.1.5-rc.2 / appVersion 0.0.2beta 各说各话 | 产品侧重置 0.0.1beta；DSH 线保留 | 机器字段用合法 semver（`0.0.1-beta`），展示串才用 `0.0.1beta` |

---

## 3. 三系统现状盘点（2026-09-22 实测）

### 3.1 记忆系统（三条腿，均不完整）

1. **工作区文件记忆**（唯一健康层）：`~/ClawMaster/memory.md`（frontmatter `schema_version=1, kind="memory"`）+ `memory/*.md` 运行手册 + `soul.md/project.md/core.md/projects/`。agent 自管的纯 markdown，人可读可改可迁移。
2. **Graph Memory 组件**（运行时上下文召回/注入）：`~/.clawmaster/components/graph-memory/`。其 `graph.sqlite` 仅两张**插件状态注册表** `units(name,version)` / `unit_globals`，各 1 行（`clawmaster_graph_memory|1`）——无实体、无关系、无面向用户的数据。同时它是 D2 的注入源头之一。
3. **OpenViking 记忆插件**：`@openviking/dsh-memory-plugin@0.3.0`，随桌面安装但**默认禁用**，需另行配置独立 OpenViking 服务；兼容补丁 `apps/desktop-tauri/patches/@openviking__dsh-memory-plugin@0.3.0.patch`（用当前 Session Projection 重建历史状态，保留请求系列标记）。"正式记忆系统"未上线。

### 3.2 笔记系统（产品内不存在）

- 产品内只有：WatchDog 会话 + 编辑器/Better Sidebar 文档面板 + Office 组件（DOCX/XLSX/PPTX 本地编辑）+ CRM/ERP 侧卡片。均为"文档/数据处理"，无笔记层。
- 用户实际笔记库：`~/Documents/ClawMaster 笔记/`（Obsidian 式 vault：`日记/ 主题/ 指南/ 方案/ 设计/ 评估/ 测试/ 欢迎.md / Codex 记忆/`）——**用户在手工维护 Obsidian 结构**，产品没有承接。

### 3.3 知识图谱（不存在）

- 主 harness `graph.sqlite`（93 会话）是会话持久化存储，不是知识图谱。
- 无实体抽取、无关系边、无双向链接索引、无可视化。

---

## 4. Obsidian 参照能力（差距矩阵的标尺）

Obsidian 的核心竞争力，逐项列出作为对齐标尺：

1. **本地优先纯文本**：vault = 一个普通文件夹的 markdown + frontmatter（YAML），零专有格式、零锁定，任何编辑器可打开，git 可版本化。
2. **双向链接**：`[[wikilink]]`/`[md](md)` 链接第一类公民；反链面板（backlinks）实时显示"谁引用了我"；未解析链接（unresolved）自动提示潜在新页面。
3. **图谱**：graph view（全库力导向图、局部图、着色分组、动画）；Canvas 白板（空间化卡片与连线）。
4. **结构化组织**：标签（嵌套标签）、属性（properties，可索引查询）、MOC（Map of Content）、daily notes（每日笔记+模板）、模板插件、书签。
5. **确定性检索**：快速切换器（模糊标题）、全文搜索（含操作符 `file: task: line:()`）、属性搜索；一切检索可复现，不经过模型。
6. **编辑体验**：live preview 所见即所得、多光标、大纲、反链内嵌、插件扩展编辑器行为。
7. **插件生态**：数千社区插件（Dataview、Templater、Calendar、Kanban…），本地 API + 主题系统。
8. **同步与版本**：官方 Sync（端到端加密）/iCloud/Git 皆可；File Recovery 快照时间线回滚。
9. **记忆可靠性**：确定性——写入即存在；无"模型没想起来"一说。
10. **人机主权**：用户对每个字节有审阅、修改、删除权；一切自动化（模板、索引）都写在用户可见的文件层。

---

## 5. 差距矩阵：ClawMaster vs Obsidian

| # | 维度 | Obsidian | ClawMaster 现状 | 定级 | 收敛动作草图 |
|---|---|---|---|---|---|
| G1 | 存储格式与可移植性 | 单一 vault 文件夹，纯 markdown | 记忆散落 4 处：`~/ClawMaster`（文件）、`~/.dsh`（会话库）、`~/.clawmaster/components/graph-memory`（状态注册）、外部 OpenViking（未启用） | **P0** | 定义统一 vault 目录规范；会话精华自动落盘为带 frontmatter 的笔记 |
| G2 | 双向链接 | wikilink + 反链面板 + 未解析提示 | 完全没有 | **P0** | 最小实现：markdown 链接解析器 + 反链索引（sqlite FTS 或倒排）+ 只读反链面板 |
| G3 | 关系图谱 | graph view + Canvas | 运行时注入机制，用户不可见；无实体/边 | **P0** | 数据模型 `entities/relations/mentions` 三表；先只读 graph view，写入后议 |
| G4 | 记忆可靠性 | 确定性（写入即存在） | 召回→注入经模型，现役链路带 D2/D11；OpenViking 禁用 | **P0** | 先修 D2；记忆写入走文件层（确定），模型只做摘要不改原文 |
| G5 | 确定性检索 | 全文/属性/快速切换 | 无独立检索层，依赖模型召回 | **P1** | vault 全文索引（sqlite FTS5，仓库已有 sqlite 依赖），模型召回只做补充 |
| G6 | 结构化组织 | 标签/属性/MOC/daily notes/模板 | 无（用户手工建目录） | P1 | frontmatter 属性规范 + daily notes 模板 + MOC 约定 |
| G7 | 同步与版本 | Sync/iCloud/Git/File Recovery | 无用户级同步；会话有 doctor 修复无用户回滚 | P1 | vault 目录直接支持 git；File Recovery 用快照代现 |
| G8 | 人机主权 | 用户审阅修改一切 | agent 写记忆，用户几乎无审阅入口（memory.md 除外） | P1 | UI：记忆/笔记的审阅-修改-删除入口；agent 写入带来源标记 |
| G9 | 编辑体验 | live preview + 插件扩展 | 通用编辑器 tab + Office 组件 | P2 | markdown live preview（Better Sidebar 面板可承载） |
| G10 | 插件生态 | 数千社区插件 | 106 技能 + 插件市场，面向任务执行 | P2 | 技能市场可承接知识管理技能（如"会议纪要入库 vault"） |

**一句话结论：ClawMaster 有"记忆行为"，没有"知识库产品"。** 记忆是给模型用的副产物，不是给用户用的资产；Obsidian 的四大核心资产（vault 文件、双链、图谱、确定性检索）一项都没有。

---

## 6. 记忆系统 v2 提案骨架（供接手人展开，非最终方案）

### 6.1 Vault 化（G1）

```
<workspace>/vault/
  memory/            # agent 记忆（原 memory.md 拆分为单条一文件）
    2026-09-21-会话库损坏修复.md
  notes/             # 用户笔记（承接 ~/Documents/ClawMaster 笔记 的结构）
  daily/             # daily notes
  templates/         # 模板
  .obsidian 兼容层？ # 决策点：是否直接兼容 Obsidian 打开同一目录
```

决策点：(a) vault 路径归属 workspace 还是用户级；(b) 是否与 Obsidian 共目录（增量兼容 frontmatter 规范即可，不必实现其全部语法）；(c) memory.md 单文件 → 单条一文件的迁移脚本。

### 6.2 双链与图谱（G2/G3）

- 解析器：支持 `[[wikilink]]` 与标准 `[text](path.md)`；未解析链接入索引提示创建。
- 索引：sqlite 表 `pages(path, mtime, hash)` / `links(src, dst, kind)` / `backlinks` 视图；增量重建（mtime+hash）。
- 图谱数据模型：`entities(id, name, type, source_note)` / `relations(src, dst, rel, evidence)` / `mentions(entity, note, offset)`；抽取先做规则级（frontmatter 属性 + 标题 + 显式链接），LLM 抽取作为可选增强且结果落盘可审。
- 可视化：只读 graph view（canvas/力导向），数据源=links 表；不做编辑。

### 6.3 确定性检索（G5）

sqlite FTS5（仓库已有 sqlite 依赖，零新增运行时）建 vault 全文索引；查询面暴露给技能（新技能 `vault-search`），模型召回（Graph Memory）降级为补充路径。**前置依赖：D2 修复**，否则注入层继续产生坏会话。

### 6.4 OpenViking 去留（决策树）

- 若 2 周内可完成 OpenViking 服务配置并验证召回质量 → 保留为"语义召回层"，文件 vault 为"事实层"。
- 否则 → 明确弃用该插件（从桌面默认插件表移除），避免"装了禁用"的中间态；语义召回后议。

### 6.5 用户主权（G8）

- UI 三入口：记忆列表（按来源过滤 agent/用户）、单条审阅-编辑-删除、变更历史。
- agent 每次写 vault 必须：单条一文件、frontmatter 带 `source: agent`、变更可回滚（git）。

---

## 7. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1（1 周） | D2 内核修复 + D7 回归修复 | PR 门禁全绿（coverage 100%/snapshot/doc-sync）；D2 修复后连续 7 天 session-doctor 零新增坏会话 |
| M2（1 周） | D9 孤儿测试纳入 CI + D12 禁用通知 | CI 出现 4 个门禁测试结果；禁用场景 UI 有提示 |
| M3（2 周） | 差距矩阵核实修订 + vault 化提案评审通过 | 评审纪要落 docs（双语三件套）；提案含数据模型与迁移脚本设计 |
| M4（3-4 周） | vault 最小实现：G1+G2+G5（vault 规范 + 双链索引 + FTS5 检索 + vault-search 技能） | 端到端演示：会话精华落盘 → 双链可见 → 全文检索命中；Obsidian 可直接打开同一目录不炸 |

## 8. 风险登记

1. **内核升级窗口**：D2/D3 的根治都压在 dsh 内核升级上，升级窗口未定——M1 先以"写侧修复进 repo 源码"落地，内核升级后自然收敛。
2. **vault 与会话库边界**：会话是历史事实（sqlite，不进 vault），vault 是提炼知识（markdown）——混淆会制造第二真相源。
3. **与 Obsidian 共目录**：只承诺 markdown+frontmatter 兼容，不承诺其插件语法（Dataview 等不实现）。
4. **OpenViking 沉没成本**：插件已随包分发，弃用需同步清理桌面默认插件表与补丁摘要计算。

## 9. 参考索引

- 缺陷登记：`docs/DEFECTS-DAWN.zh.md` / `docs/DEFECTS-DAWN.md`；状态：`docs/STATUS-2026-09-21.zh.md`
- 会话修复手册：`~/ClawMaster/memory/2026-09-21-session-role-repair-runbook.md`；探针报告：`~/ClawMaster/memory/2026-09-21-enterprise-plugin-probe-report.md`
- 版本重置决策：`.agents/notes/implemented/process/2026-09-21-product-version-reset.md`
- 更新通道协议：`.agents/notes/implemented/architecture/2026-09-15-versioned-native-update-targets.md`
- 桌面插件与补丁清单：`apps/desktop-tauri/README.zh.md`
- 桌面组件目录：`~/.clawmaster/components/`（graph-memory / open-code-review / pdf / voice）
