# ClawMaster

ClawMaster 是桌面优先的 AI 智能操作中台。它把 Agent 执行、项目记忆、
Skill 沉淀、企业协作和业务系统操作放进一个可审计、可扩展的本地工作台，
面向个人生产力，也面向企业内不同部门和群聊承载的专业工作流。

当前版本：`0.0.2-beta.1`

正式发行矩阵：Windows x64、macOS ARM64

桌面运行时：Tauri v2 + Rust；安装后的应用不携带 Node.js 运行时

> Beta 版本仍需经过对应平台的安装与真实用户路径验收。构建成功不等于
> 所有外部平台、模型账号或企业通道已经完成授权。

## 核心能力

- **Agent 工作台**：流式对话、工具调用、任务编排、检查点、策略确认和审计事件。
- **自动项目归档**：根据明确文件路径或唯一匹配的已使用项目，将未归类会话归入项目；无法可靠判断时保持待确认，不猜测归属。
- **自动 Skill 沉淀**：识别重复且可追溯的工作路径，生成 Skill 候选；需要用户确认后才写入项目目录。
- **功能模块候选**：当一项能力不适合由 Skill 承载时，以虚线功能方块呈现，确认后再生成和完善模块。
- **右侧通用工作区**：内置浏览器、思维导图阅览器和文件工作区；原生预览或编辑文本、代码、Markdown、DOCX、PDF、PPTX、XLSX，并以新文件保存修改。
- **电商市场分析**：内置可追溯的分析工作区，覆盖客户研究、竞品矩阵、渠道与价格、机会缺口、风险及 30/60/90 天行动计划。
- **企业协作入口**：飞书支持 Rust 原生双向消息链路；企业微信和钉钉当前支持凭证安全存储与出站测试，入站长连接仍在完善中。
- **轻量桌面发行**：正式安装包仅包含 Rust/Tauri 运行所需内容，发行门禁会拒绝遗留 Node、SQLCipher binding 和旧 Agent payload。

## 业务平台

桌面端默认提供以下业务入口，并通过模块目录保持可扩展，而不是把平台逻辑写进 Agent 内核：

| 平台 | 场景 | 地址 |
| --- | --- | --- |
| 鸿雁知访 | 外勤系统 | <https://47.116.30.60/> |
| 穿山甲 | 溯源大师 | <https://8.140.52.117/> |
| 知了猴 | 电商经营 | <http://47.116.30.60:18787/> |
| 智信鸽 | 全能 AI 客服 | <http://47.116.30.60:18788/> |
| 猫头鹰 | 控价助手 | <http://8.141.8.31/> |

平台操作遵循授权、确认和审计规则。分析报告必须区分事实、推断和建议；
任何发布、修改或对外发送都需要再次确认。

## 架构

ClawMaster 使用 npm workspaces 管理源码，但正式桌面应用由 Tauri/Rust 构建，
最终用户不需要安装 Node.js。

| 目录 | 职责 |
| --- | --- |
| `packages/core` | Agent 回合生命周期、工具调度、策略、模型路由、记忆接口、检查点与子 Agent |
| `packages/server` | 本地与企业服务、HTTP/WebSocket 协议、组织权限、知识和协作适配 |
| `packages/desktop` | Tauri v2 桌面壳、React 界面、Rust 原生能力和发行门禁 |
| `clawmaster-native` | 可选原生加速桥及其 TypeScript 接口 |

运行时内核只负责生命周期关键能力。桌面 UI、企业业务、模型供应商适配器、
长期记忆实现、Skills、连接器和发行脚本都必须位于内核边界之外。详见
[运行时内核边界](docs/runtime-kernel-boundary.md) 和 [代码地图](docs/code-map.md)。

## 本地开发

前置条件：Node.js `>=22.13.0`、Rust stable；macOS 还需要 Xcode Command Line Tools。

```bash
git clone git@github.com:NSIETeam/ClawMaster.git
cd ClawMaster
npm ci
npm run doctor
npm --workspace packages/desktop run tauri:dev
```

构建正式桌面包：

```bash
npm --workspace packages/desktop run tauri:build
```

常用验证命令：

```bash
npm run doctor
git diff --check
npm run validate:integration-baseline
npm run validate:boundaries
npm run code-map:check
npm run typecheck
npm run lint:ci
npm run test:ci
```

## 发布规则

唯一正式桌面发布工作流是
[`.github/workflows/tauri-preview.yml`](.github/workflows/tauri-preview.yml)。
发布矩阵永久收敛为 Windows x64 和 macOS ARM64。正式产物必须通过：

1. 仓库、集成、RPA 与压力预检。
2. 两个平台各自的 Rust 测试和 Tauri 构建。
3. 安装包结构、大小、遗留运行时拒绝和 SHA-256 校验。
4. 与版本完全一致的 `v<version>` 标签及明确发布授权。

手动触发默认只生成候选产物，不会发布 GitHub Release。完整说明见
[GitHub Actions](.github/workflows/README.md)。

## 安全原则

- API Key 和企业凭证只进入系统钥匙串或受保护的凭证存储，不写入仓库、日志或 README。
- 高风险工具必须经过确认、策略和审计路径；拒绝与取消都是明确可见的结果。
- 自动项目归档、Skill 生成和企业知识沉淀在证据不足时一律 fail closed。
- 外部业务平台和群聊连接器保持可替换，不能成为运行时内核的隐式依赖。

## 文档

- [架构概览](docs/architecture.md)
- [产品模块边界](docs/product-modules.md)
- [核心运行时](docs/core/index.md)
- [工具目录](docs/tools/index.md)
- [Skills 使用说明](docs/skills-usage.md)
- [自定义模型](docs/custom-models-quickstart.md)
- [贡献指南](docs/CONTRIBUTING.md)

## License

See [LICENSE](LICENSE).
