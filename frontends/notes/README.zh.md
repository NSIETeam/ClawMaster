---
description: "ClawMaster 笔记：本地 Markdown 编辑、双向链接、搜索与逐次审批的智能体写入。"
kind: "package-bundle"
---

# ClawMaster 笔记

[English](README.md) | 中文

## 摘要

ClawMaster 内置本地笔记库，支持 Markdown 编辑、预览、双向链接、反链、标签和文本搜索。你可以让智能体把工作整理成笔记，并逐次批准写入。产品自行创建笔记库，无需安装 Obsidian。已保存笔记是普通文件；未保存草稿仅保留在本次应用运行的内存中。

## 目录

- [使用此组件](#use-this-package)
- [配置](#configuration)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [验证](#verification)
- [进一步阅读](#further-exploration)

<a id="use-this-package"></a>
## 使用此组件

这个私有组件通过[配置层补丁](cordis.patch.yml)包含在 ClawMaster 桌面配置中。在侧栏标签选择器中打开**笔记**。插件加载时，主机创建配置的笔记库；库中没有受支持笔记时，写入一篇欢迎笔记。

新建或打开笔记，编辑文本后选择**保存**。版本冲突会同时保留本地草稿和磁盘上的较新文件。**重新载入**会先确认是否放弃草稿。插件保持加载时，切换笔记或关闭后重新打开笔记标签，会保留同一会话的草稿。**删除**需要确认，且不会移入废纸篓。

<a id="configuration"></a>
## 配置

[主机配置](src/host.ts)接受绝对路径 `vaultRoot`。默认位置在 macOS 上为 `~/Documents/ClawMaster 笔记`，其他平台为 `~/ClawMasterNotes`，位于桌面运行时目录之外。读取、目录列表、搜索、标签和反链共用以下限制；追加操作也遵守读取限制。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `limits.maxReadBytes` | 262144 | 单篇笔记的最大读取字节数。 |
| `limits.maxTreeEntries` | 5000 | 目录列表允许访问的最大笔记数。 |
| `limits.maxSearchResults` | 50 | 默认及最大搜索结果数，可配置到 200。 |

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[主机](src/host.ts)在现有、已鉴权的 DSH Fetch 通道注册六个路由，均位于 `/api/clawmaster/notes/`：GET `tree`、`note`、`search`、`tags`、`backlinks`，以及 POST `command`。通道负责鉴权和来源检查；浏览器携带同源凭据。组件不启动额外服务器。工具定义、执行上下文和审批采用 DSH 公共类型。卸载时移除注册项、取消待处理审批，并等待正在执行的操作结束。

[笔记库存储](src/vault.ts)拒绝规范根目录以下的链接文件及链接目录。协作写入者共用跨进程文件锁；版本检查和改动回执在持锁期间计算。保存通过原子替换发布完整临时文件。创建和重命名使用硬链接，拒绝覆盖已有目标。浏览器渲染解析后的 Markdown 数据，不直接渲染原始 HTML；[共用文本解析](src/note-format.ts)不重写 frontmatter。

</details>

<a id="model-experience"></a>
## 模型体验

`notes_query`读取配置的笔记库，不请求写入审批。`notes_write`执行创建、保存、追加、重命名、删除或添加带日期的日记条目。每次 AI 写入都要求所属 DSH 智能体会话及 `allowed-once` 一次性批准；拒绝、取消或插件卸载会阻止仍在等待审批的操作提交。保存须提供读取时获得的版本，不一致时返回冲突。回执记录改动前后的版本，不提供被删除或替换内容的可恢复副本。已鉴权的界面命令属于用户编辑，不额外请求智能体审批。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- Markdown 编辑支持部分格式；组件不实现 Obsidian 插件或画布编辑器。搜索扫描文件，不使用持久索引。
- 草稿不跨进程退出持久化。有草稿时会触发浏览器卸载提醒；原生应用退出保护尚未验证。
- 文件锁协调协作写入者，不能隔离恶意或非协作进程替换祖先目录、或争抢最后一次文件系统操作。写入不承诺通过 `fsync` 保证崩溃持久性。
- 创建和重命名需要文件系统支持硬链接。重命名清理失败可能保留两个路径，并明确报错。异常退出遗留的锁需人工确认后恢复，组件不会自动删除。

<a id="verification"></a>
## 验证

在已安装开发依赖的仓库根目录运行存储与主机测试、编译后客户端交互、类型检查和产物一致性检查：

```sh
npm --prefix frontends/notes test
pnpm exec vitest run --config frontends/notes/tests/vitest.client.config.ts
npm --prefix frontends/notes run typecheck
node frontends/notes/scripts/build.mjs --check
```

这些检查使用合成文件和受控浏览器响应，不代表最终安装版笔记界面已经验收。

<a id="further-exploration"></a>
## 进一步阅读

参见[设计决策](../../.agents/notes/implemented/feature/2026-09-13-clawmaster-notes-vault.zh.md)、[通信校验](src/protocol.ts)和[桌面集成](../../apps/desktop-tauri/README.zh.md)。

### 开发备注

无。
