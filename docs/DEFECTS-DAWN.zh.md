# ClawMaster 系统缺陷清单 — 内核代号 Dawn

[English](DEFECTS-DAWN.md) | 中文

**基线**：desktop 0.0.1beta（2026-09-21 版本重置）· dsh 0.1.5-rc.2（harness `72da6c767414dd30`）· 本文档对齐本地稳定运行版本
**更新**：2026-09-21

---

## 一、已根治（本机验证通过）

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| F1 | 微信通道全部回复 `INTERNAL_UNKNOWN` | 环境残留（profiles/node_modules 旧插件副本）+ 会话历史损坏 | 清理残留 + 重置会话（`~/ClawMaster/memory/` 有手册） |
| F2 | 历史加载一票否决（一条坏会话全部挂） | 上下文注入写 `user/message` 缺 `role/id/source`，校验器 strict | 21 会话/93 事件修复；`session-doctor.mjs` 每 30 分钟自愈（launchd） |

## 二、现存缺陷（Dawn 内核）

| # | 缺陷 | 影响 | 缓解 | 根治方向 |
|---|---|---|---|---|
| D1 | **会话扫描一票否决**：`WorkspaceRegistry.listStoredHeaders` 对任一坏会话整体失败 | 一条坏会话 → 全部历史不可见 | session-doctor 自愈兜底 | 逐会话隔离（"每会话=独立插件"）；本地分支已含 `isolate loader entry failures at boot` |
| D2 | **上下文注入写事件缺字段**：技能目录回放 / Graph Memory 召回追加的 `user/message` 缺 `role/id/source` | 持续产生坏会话（D1 的源头） | doctor 自愈 + 运行时读取自愈补丁 | 内核修复 `createUserMessage` 默认 role |
| D3 | **运行时完整性恢复**：`harness-versions/` 内文件会被恢复为 pristine，任何运行时补丁在重启/维护后失效 | 读取自愈补丁不持久 | 升级内核后补丁不再需要 | 升级 dsh 内核 |
| D4 | **并发锁冲突**：headless/探针进程与 App 启动并发持有 `graph.sqlite` 写锁 | notes/graph-memory 插件初始化失败被救援禁用 → UI 任务列表清空（无 UI 报错） | 避免探针与 App 启动并发；重启即恢复 | 插件加载锁等待/重试 |
| D5 | **overlay 配置被重写**：`desktop-overlay/cordis.yml` 每次启动被应用重写回模板 | 自定义插件丢失 | 自定义插件放用户层 `~/.dsh/cordis.patch.yml`（不重写） | 应用保留用户 insert |
| D6 | **MCP 桥仅支持 stdio** | 4 个 ZCode 托管 HTTP MCP 插件（同花顺/万得/天眼查/金融聚合搜索）无法原生使用 | 在 ClawMaster 插件市场原生安装 | MCP 桥支持 http 传输 |
| D7 | **浏览器启动 400 回归**：`browser-open.spec.ts` 期望 200 实得 400（单跑复现） | web 启动握手异常 | 未修 | 排查 token/host 校验变更 |
| D8 | **版本号硬编码漂移**：`packages/server/src/server.ts` appVersion 与产品版本脱节（曾为 0.0.2beta） | 版本一致性门禁红灯 | 已解决：2026-09-21 版本重置，appVersion=0.0.1beta 与桌面端 0.0.1-beta 一致 | 从 package.json 注入 |
| D9 | **孤儿门禁测试**：`scripts/tests/*.test.js` 不在任何 vitest include | CI 不执行发布门禁 | 手动 `vitest run --config /tmp/vitest.empty.mjs` | 纳入 vitest include |
| D10 | **lint 债**：快照目录 6.4 万风格错误（semi/indent 等） | `pnpm lint` 全局红灯 | 不阻塞构建 | `oxlint --fix` 批量清理 |
| D11 | **技能目录选择噪声**：134 条目录条目，模型初期会按名字浅匹配选错 | 首次选择可能错技能 | 技能纪律系统段 + 中文触发词（探针 10/10 通过） | 按工作区分域加载技能 |
| D12 | **救援禁用无感知**：插件启动失败被 rescue 禁用时 UI 无任何提示 | 用户不知道功能缺失（D4 的表现被放大） | 无 | UI 通知 + 健康面板 |

## 三、已关闭项

- ~~`NSIETeam/ClawMaster` 仓库~~：2026-09-21 删除（归档后清理），唯一远端为 `NSIETeam/ClawMaster`（原 ClawMaster-Desktop 改名）。
- 旧产品线（companyos 等 208 提交）保留于 tag `legacy/main-pre-dsh`，未丢失。
