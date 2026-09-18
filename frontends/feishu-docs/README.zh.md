# @clawmaster/dsh-feishu-docs

ClawMaster 智能体的**只读**飞书（Lark）云文档能力：让它能读公司文档，而不只是读那些碰巧发到
飞书机器人手里的消息。

## 接口

七个智能体工具。全部是 L0 观察级：**没有一个需要审批，本包不注册任何写入工具。**

| 工具 | 作用 | 所需飞书权限 |
|---|---|---|
| `feishu_whoami` | 报告应用身份（机器人名、open id、激活状态）。 | bot |
| `feishu_capabilities` | 探测每个读接口，并列出飞书说缺哪些权限。 | — |
| `feishu_doc_read` | 把一篇 docx 文档渲染成 Markdown。接受 token 或直接粘贴 URL。 | `docx:document:readonly` |
| `feishu_wiki_spaces` | 列出该应用可见的知识库空间。 | `wiki:wiki:readonly` |
| `feishu_wiki_nodes` | 列出某空间的节点，可按父节点过滤。 | `wiki:wiki:readonly` |
| `feishu_wiki_read` | 把 wiki 节点解析到底层文档并渲染。 | `wiki:wiki:readonly` |
| `feishu_drive_list` | 列出云盘某目录下的文件与文件夹。 | `drive:drive:readonly` |

两条带鉴权的 Fetch 路由把诊断信息暴露给界面：`GET /api/clawmaster/feishu/whoami` 与
`GET /api/clawmaster/feishu/capabilities`。鉴权与来源校验由 DSH Fetch 载体负责。

`feishu_capabilities` 存在的理由：从外部看，「没有文档」和「没有权限」长得一模一样。缺少权限时
会连同飞书返回的确切权限名一起报出；身份查询失败时记入 `identityError`，而探测仍然继续执行。

## 配置

```yaml
- id: clawmaster-feishu-docs
  name: '@clawmaster/dsh-feishu-docs'
  config:
    appId: cli_xxxxxxxxxxxxxxxx
    appSecretRef: DSH_FEISHU_APP_SECRET_XXXXXXXX
    # domain: feishu | lark        （默认 feishu）
    # timeoutMs: 20000
    # maxRetries: 3
```

`appId` 与 `appSecretRef` **刻意没有默认值**：飞书应用属于部署方自己的租户，因此这两项是配置，
永远不会是常量。

`appSecretRef` 指向 DSH 凭证库中的一个引用，以 `ctx.credentials` 注入。密钥在每次获取租户
token 时按需解析，绝不作为字段存在客户端上，也不进 prompt、不进日志。客户端只缓存派生出的
短期租户 token，因此密钥轮换会在下次刷新时自动生效。

## 需要开通的飞书权限

应用必须开通以下只读权限**并发布版本**，否则每个文档接口都会返回 `99991672`：

```
docx:document:readonly
wiki:wiki:readonly
drive:drive:readonly
contact:contact.base:readonly   （可选）
```

## 结构

- `src/errors.ts` —— 错误分类：缺权限、鉴权失败、限流、配置缺失是不同类型，确保「没有权限」
  不会被误当成「空文档」。
- `src/client.ts` —— 租户 token 缓存与单飞、带退避的有界重试、分页游标遍历（含「服务端反复
  返回同一 token」的兜底）。
- `src/markdown.ts` —— docx blocks 转 Markdown，按 page/children 树遍历。渲染器不认识的
  block 类型会变成一条显式 HTML 注释，因此有损转换永远可见。
- `src/resources.ts` —— docx / wiki / drive 读取器与能力探测。
- `src/protocol.ts` —— 路由路径、参数 schema、文档 token 提取。
- `src/host.ts` —— cordis 插件本体：`inject = ['connection', 'tools', 'credentials']`、
  路由与工具注册、卸载时清理。
- `tests/` —— 客户端生命周期、Markdown 渲染、宿主接口，用 `node --import tsx/esm --test` 运行。

**只有宿主半边**：本能力没有界面部分，因此不构建客户端 bundle，包也不声明 `dsh.client`。

## 已知缺口

- **还没有空间 / 目录白名单。** 当前每次读取只受「飞书应用本身能看到什么」约束。计划加入对知识库
  空间与云盘目录的默认拒绝白名单，并为每次读取留下审计记录。
- **代码块不带语言标记。** `code.style.language` 是个枚举，其取值尚未对真实文档核验过，因此不做
  任何映射断言。
- **`feishu_doc_read` 无法按空间限制。** 裸文档 token 不携带其所属知识库空间；这类读取由应用在
  飞书侧的文档权限管辖。
