# ClawMaster 系统缺陷登记册——内核代号 Dawn

[English](DEFECTS-DAWN.md) | 中文

**基线**：desktop 0.0.1beta · dsh 0.1.5-rc.2（harness `72da6c767414dd30`）· 仓库 `main` 位于 `5566bec824af45290596e50f938c880ae154aedf`，另包含 Issue #32 任务分支

**更新日期**：2026-09-22

---

## 1. 已定位根因（本机验证）

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| F1 | 微信渠道对所有消息回复 `INTERNAL_UNKNOWN` | 环境残留（profiles/node_modules 下的旧插件副本）和损坏的会话历史 | 清理残留并重置会话（操作手册位于 `~/ClawMaster/memory/`） |
| F2 | 一个坏会话阻断全部历史加载 | 上下文注入写入缺少 `role/id/source` 的 `user/message`，而校验器严格拒绝该事件 | 已修复 21 个会话、93 个事件；`session-doctor.mjs` 每 30 分钟自愈一次（launchd） |

## 2. Dawn 内核缺陷

| # | 缺陷 | 影响 | 缓解措施 | 根本修复 |
|---|---|---|---|---|
| D1 | **会话扫描连带失败**：`WorkspaceRegistry.listStoredHeaders` 过去会因任一坏会话而整体失败 | 一个坏会话可能隐藏全部历史 | **已修复**：逐会话隔离损坏条目 | [#14](https://github.com/NSIETeam/ClawMaster/issues/14) |
| D2 | **上下文注入曾写入字段不完整的事件**：skill-catalog 回放或 Graph Memory 召回可能追加缺少 `role/id/source` 的 `user/message` | 持续产生坏会话，是 D1 的来源 | **已修复**：写入侧 append 自愈；聚焦会话测试 77 项通过 | [#15](https://github.com/NSIETeam/ClawMaster/issues/15) |
| D3 | **运行时完整性恢复**：`harness-versions/` 下的文件会恢复为原始版本，任何运行时补丁都会在重启或维护后丢失 | 读取侧自愈补丁无法持久化 | 内核升级后不再需要该补丁 | 升级 dsh 内核 |
| D4 | **并发锁冲突**：无头探针和应用启动可能同时持有 `graph.sqlite` 写锁 | notes/graph-memory 插件初始化失败后可能被救援机制禁用 | **已修复已知来源**：`busy_timeout` 已落地；验证构造器级行为时避免并发探针 | [#17](https://github.com/NSIETeam/ClawMaster/issues/17) |
| D5 | **覆盖层配置被重写**：应用每次启动都会把 `desktop-overlay/cordis.yml` 重写为模板 | 自定义插件丢失 | 自定义插件放入不会被重写的用户层 `~/.dsh/cordis.patch.yml` | 应用保留用户插入内容 |
| D6 | **ZCode 托管的金融 MCP 插件不可用**——内核已经支持 streamable-http；阻塞项是 ZCode 付费套餐权限（探针结果：网关可达、JWT 可识别、JSON-RPC 1006“无权限”） | 4 个插件（同花顺、Wind、天眼查、金融搜索）需要带金融 MCP 权限的 ZCode 套餐 | 升级 ZCode 套餐后通过 streamable-http（URL + Bearer）接入，或安装 ClawMaster 托管的等价插件 | [#19](https://github.com/NSIETeam/ClawMaster/issues/19) |
| D7 | **浏览器启动 400 回归**：`browser-open.spec.ts` 期望 200，实际为 400 | 旧测试夹具的 dist index 缺少 CSP nonce 渲染要求的 `<head>`，不是产品回归 | **已在 Issue #32 分支修复**：夹具改为合法 HTML，聚焦浏览器测试返回 200 | [#20](https://github.com/NSIETeam/ClawMaster/issues/20) |
| D8 | **硬编码版本漂移**：版本字面量散落在 server.ts、browserPreviewBridge 和 enterprise bin.ts | 版本一致性门禁失败 | **已修复**：全部字面量与根 package.json 对齐；长期仍应采用单一来源注入 | [#21](https://github.com/NSIETeam/ClawMaster/issues/21) |
| D9 | **仅快照分支存在的门禁测试**：`scripts/tests/*.test.js` 及其 enterprise/E2EE 生产源码位于 `dsh-workline`，不在当前仓库 `main` | 单独复制测试会为不存在的产品代码建立虚假门禁 | 在所属开发线保留覆盖；若功能晋升，生产代码与测试必须一并移植 | [#22](https://github.com/NSIETeam/ClawMaster/issues/22) |
| D10 | **Lint 技术债**：历史快照曾报告大量样式问题 | 当前权威信号应为仓库级 lint | 不沿用过期数量；按包处理当前 lint 结果 | [#23](https://github.com/NSIETeam/ClawMaster/issues/23) |
| D11 | **技能目录选择噪声**：目录曾有 134 项，模型初次按名称浅匹配时可能选错 | 首次选择可能加载错误技能 | 技能纪律系统提示段、中文触发短语（探针 10/10 通过） | 按工作区领域加载技能 |
| D12 | **救援禁用曾无提示**：插件启动失败后可能被禁用，界面却没有提示 | 用户不知道某项能力已经缺失 | **已修复**：仅本地运行时健康接口报告被禁用插件名称，Home 层展示这些名称 | [#25](https://github.com/NSIETeam/ClawMaster/issues/25) |

## 3. Issue #32 校正：记忆、笔记与知识图谱

当前 `main` 已具备本地 Markdown 仓库、frontmatter、标签、日记、Wiki 链接、反向链接、搜索、提案/差异、批注和审批。Graph Memory 已具备类型化节点与边、BM25 检索、未解析链接追踪，以及持久化的原子图快照。剩余差距更窄但仍然重要：图谱界面还不是真正的交互图，Notes 搜索仍依赖文件扫描，Graph Memory 会重建单体快照，同时缺少恢复、同步、模板和旧 `memory.md` 迁移能力。

拟议的 v2 架构、校正后的十维对比、迁移边界、验收标准和 OpenViking 决策门禁记录在[兼容 Obsidian 的知识库 v2](../.agents/notes/proposed/architecture/2026-09-22-obsidian-compatible-knowledge-vault-v2.zh.md)。该文档仍为**提案**：数据库结构、迁移和图谱界面必须在架构评审通过后实施。

## 4. 已关闭事项

- ~~`NSIETeam/ClawMaster` 仓库~~：2026-09-21 删除（归档后清理）；唯一远端为 `NSIETeam/ClawMaster`（由 ClawMaster-Desktop 重命名而来）。
- 旧产品线（companyos，共 208 次提交）保存在标签 `legacy/main-pre-dsh` 中，未丢失任何内容。

---

## Issue 索引

每个登记项均在 GitHub（[NSIETeam/ClawMaster](https://github.com/NSIETeam/ClawMaster/issues)）跟踪：

| 条目 | Issue | 状态 |
|---|---|---|
| D1 会话扫描连带失败 | [#14](https://github.com/NSIETeam/ClawMaster/issues/14) | 已关闭：源码中的列表隔离（4596ec2755）和现场运行时读取自愈 |
| D2 注入缺失字段 | [#15](https://github.com/NSIETeam/ClawMaster/issues/15) | 已关闭：写入侧 append 自愈（501/501）和现场读取自愈 |
| D3 运行时完整性恢复 | [#16](https://github.com/NSIETeam/ClawMaster/issues/16) | 打开 |
| D4 graph.sqlite 锁冲突 | [#17](https://github.com/NSIETeam/ClawMaster/issues/17) | 已关闭：`busy_timeout` 已落地；构造器级行为仍需验证 |
| D5 覆盖层重写 | [#18](https://github.com/NSIETeam/ClawMaster/issues/18) | 已关闭（用户层补丁已验证） |
| D6 MCP 仅 stdio | [#19](https://github.com/NSIETeam/ClawMaster/issues/19) | 打开（等待 marketplace 原生安装） |
| D7 browser-open 400 | [#20](https://github.com/NSIETeam/ClawMaster/issues/20) | 已关闭（旧夹具） |
| D8 版本漂移 | [#21](https://github.com/NSIETeam/ClawMaster/issues/21) | 已关闭（字面量已对齐） |
| D9 仅快照存在的门禁测试 | [#22](https://github.com/NSIETeam/ClawMaster/issues/22) | 已在所属快照关闭；当前 `main` 不存在该代码 |
| D10 lint 技术债 | [#23](https://github.com/NSIETeam/ClawMaster/issues/23) | 已关闭；以当前仓库 lint 为准 |
| D11 技能目录噪声 | [#24](https://github.com/NSIETeam/ClawMaster/issues/24) | 已关闭：纪律提示段（探针 10/10）、中文触发词和开发技能冷存储（134→124） |
| D12 静默降级 | [#25](https://github.com/NSIETeam/ClawMaster/issues/25) | 已关闭：本地运行时健康接口、Home 层禁用插件名称和原生救援日志 |
