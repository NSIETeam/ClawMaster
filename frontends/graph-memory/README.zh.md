---
description: "面向桌面用户与 profile 维护者，统一检索 ClawMaster 笔记、agent 记忆与文件元数据。"
kind: "package-bundle"
---

# @clawmaster/dsh-graph-memory

[English](README.md) | 中文

## 摘要

Graph Memory 让 agent 通过同一条排序路径检索笔记与长期记忆，并在侧边栏展示同一批主题和相似文件。ClawMaster Desktop 内置这个层。每条结果都会说明触发召回的命中词或图关系。索引是位于笔记库之外的派生状态，刷新只读 OpenViking，不向其中写入。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

ClawMaster Desktop 在默认 profile 中安装此 bundle。它的 patch 关闭 Notes 包中只按名称匹配的上下文桥，把 SQLite 存储后端挂载到 `~/.clawmaster/components/graph-memory/graph.sqlite`，然后在 Notes 之后挂载 Graph Memory。

### 获得的能力

`graph_memory_query` 用同一套 BM25 排序检索笔记正文与 OpenViking 记忆，并沿 wiki 链接、词法相似、重复关系和主题扩展结果。`graph_memory_refresh` 在进程内重建派生快照，向模型返回生成时间及文档、节点、边的数量，而非完整索引。`graph_memory_plan_writeback` 把结论、决定和证据分到笔记，把偏好和稳定事实分到记忆；它以预览形式返回互相的 `[[链接]]`，不执行写入。

侧边栏列出主题页和带依据的相似文件对。额外文件目录通过 `fileSources` 显式启用。Markdown 与文本文件贡献可检索正文；演示文稿、电子表格、PDF、图片及其他二进制文件只贡献名称、路径、大小、时间戳和扩展名。

文件结果在所有平台上都用 `/` 分隔目录。文件的后备标题使用文件名；配置的来源路径和文本正文保留原始字符。

### 验证当前检出

```bash
npm --prefix frontends/graph-memory test
npm --prefix frontends/graph-memory run typecheck
node frontends/graph-memory/scripts/build.mjs --check
npm --prefix frontends/graph-memory run test:real-vault
```

最后一条命令读取已配置的真实 Notes 笔记库与 OpenViking 服务。它只输出聚合数字；若没有任何查询同时召回笔记与记忆，命令就失败。它不会写入任一来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

此 bundle 插入两个条目：SQLite 存储提供器与 Graph Memory Host/client 包。Host 通过 `clawmasterNotes` 读取笔记，通过 HTTP API 读取 OpenViking，在进程内构建完整且可表示为 JSON 的图，并原子替换 `ctx.storage` 中的一个 KV 值。工具输出使用 DSH 支持的 schema，输入与领域细化校验仍由 zod 负责。工具直接调用同一引擎；组件不启动子进程，也不直接导入 SQLite。

每回合第 1 个 step，上下文监听器先委托给下一个监听器，再刷新和查询统一图。注入的用户消息以 `clawmaster-graph-memory` 为插件来源并使用 `form: snapshot`，所以下一回合的快照会覆盖上一回合。笔记清单读取失败时，组件记录错误并原样返回该 step。

词法解析器与图算法改编自已审查的零依赖 GraphRAG 源码。独立 SQLite 适配器、CLI、watch 进程、评估运行器和静态 HTML 查看器不进入此组件。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ClawMaster Notes](../notes/README.zh.md)负责笔记读取、写入、修订与批注。
- [桌面打包](../../apps/desktop-tauri/README.zh.md)负责 bundle 安装与重启行为。

-----

<a id="model-experience"></a>
## 模型体验

直接。模型可以查询统一图，并在每回合开场 step 收到一份带来源的上下文快照。结果包含词法或关系依据，并保留同标题重复条目标注。

#### KV 缓存影响

每回合贡献一份有界快照。后一份快照替换此前的插件贡献，不会再追加一个持久前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 尚未启用 OpenViking 语义向量边；检索使用已交付的词法图与结构图。
- 长期记忆摄取没有执行路径。写回分类与互相链接只是预览，因为记忆写入需要另行获得 owner 批准的设计。
- 源码变化不会激活到正在运行的桌面进程。桌面重建与重启是由 owner 控制的独立操作。

<a id="dev-note"></a>
### 开发说明

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
