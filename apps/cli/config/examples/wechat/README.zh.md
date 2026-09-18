---
description: "个人微信和公众号 MCP 可选配置、审批、前置条件与验证范围。"
---

# 微信集成

[English](README.md) | 中文

## 概述

这些源码配置通过已有 MCP 客户端连接个人微信和公众号草稿箱。两种集成都不默认启动。每次受支持的调用都需要一次性审批，包括读取聊天和列出主题。这些文件不代表已安装的桌面发行版，也不是新的设置页面。

## 目录

- [选择与配置](#choose-and-configure)
- [安全与失败处理](#safety-and-failures)
- [验证](#verification)

<a id="choose-and-configure"></a>
## 选择与配置

[personal.cordis.yml](personal.cordis.yml) 使用 [BiboyQG/WeChat-MCP](https://github.com/BiboyQG/WeChat-MCP)，MIT 许可，版本为 `wechat-mcp-server==0.2.0`。上游通过 macOS 辅助功能支持读取近期聊天、回复、好友申请和纯文字朋友圈。该项目处于 Alpha 阶段，不是完整历史数据库接口。操作者需准备 macOS、Python 3.12 或更新版本、`uvx`、已登录的微信桌面客户端，以及所需的辅助功能和屏幕录制权限。不要为此关闭 macOS 安全保护。

[official.cordis.yml](official.cordis.yml) 使用 [caol64/wenyan-mcp](https://github.com/caol64/wenyan-mcp)，Apache-2.0 许可，版本为 `@wenyan-md/mcp@2.0.3`。上游负责 Markdown 排版、上传素材和将文章存入公众号草稿箱；`publish_article` 不代表公开发布。操作者需准备 Node/npm，在本地启动环境中设置 `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`，并将出口 IP 加入公众号后台允许列表。不要把凭据放进提示词、提交的配置或命令参数。配置使用本地 stdio，不连接第三方托管服务。

源码 CLI（命令行界面）通过重复的 `--patch` 参数同时接受两份配置；只需保留其中一份即可仅启用对应账号类型。以下检查命令仅合成配置，不启动任何服务；输出可能包含凭据，请仅在本地查看：

```sh
pnpm dsh --profile web --patch apps/cli/config/examples/wechat/personal.cordis.yml --patch apps/cli/config/examples/wechat/official.cordis.yml --dump-config
```

账号启用属于操作者验收步骤：确认前置条件后，移除 `--dump-config` 即可启动 web 配置。首次启用会下载指定版本的顶层包，但传递依赖未锁定。受控部署请使用经过审核的本地安装，并替换可执行文件配置。移除对应的 `--patch` 并重启即可禁用集成。两份配置都必须保留审批条目；修改命名空间时也必须同步修改策略。

<a id="safety-and-failures"></a>
## 安全与失败处理

[审批插件](approval.mjs) 只接受已审核的工具名称，通过已有的可记录审批能力发出请求，并在执行前再次检查授权。没有审批渠道、拒绝、取消、参数变化或绕过审批的策略监听器都会阻止执行。其他策略的拒绝仍然有效。其他命名空间不受影响。具有配置或 shell 权限的操作者可以修改这些保护；这不是操作系统沙箱。

个人微信工具可能移动焦点并披露私人聊天。公众号工具可能读取本地文件、抓取 URL、上传内嵌图片并修改主题。审批不等于文件系统或网络隔离：请检查所有路径、URL、收件人和文章内容。上游工具有时会将失败放在成功的 MCP 响应内部；宣告成功前需检查返回详情以及实际聊天或草稿。写入后超时意味着结果未知：重试前先检查微信。自动重连已禁用，两份配置都不添加自动调用重试。

如果 npm 针对缓存报告 `EACCES`，请在启动环境中将 `npm_config_cache` 设置为独立可写目录。本开发主机的默认 npm 缓存中存在 root 所有的条目；这是本地安装失败，不是公众号认证失败。不要递归修改无关主目录的权限。

<a id="verification"></a>
## 验证

[无密钥测试](../../../tests/wechat-mcp.spec.ts) 使用协议 fixture（测试前置数据）覆盖真实 Loader/MCP 工具发现和审批拦截，不触碰账号。fixture 不能证明上游服务的账号操作可用。真实账号读取、审批后发送、素材上传、草稿可见性、已安装桌面打包和完整 agent（智能体）会话录制场景仍需分别验收。[决策记录](../../../../../.agents/notes/implemented/feature/2026-09-15-wechat-mcp-approval.zh.md) 说明安全选择。

## 开发备注

以下是验证记录，不代表发行验收：2026-09-15 的文颜真实服务发现尝试未完成 `tools/list`：默认缓存遇到 `EACCES`，独立缓存尝试以 npm 锁及清理错误结束。安装还提示 `@xmldom/xmldom@0.9.10` 已弃用；这是待处理的依赖审核项，不是漏洞已被利用的证据。这里尚未完成任何上游服务的真实账号验收。不能仅凭 fixture 测试将这些可选源码示例提升为生产发行版。
