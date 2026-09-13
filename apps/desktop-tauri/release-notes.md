# ClawMaster WatchDog 0.2.0-release

## 中文

开启AI时代的企业协作。WatchDog 是使用 Tauri 桌面壳与 DSH 运行时的本地企业协作工作台，复用现有模型凭证、会话、工具、审批和插件。程序版本为 `0.2.0`，发布名称为 `0.2.0-release`。

- **任务跟进**：首次教程围绕业务目标、责任、验收与巡检。工作台优先展示待审批、待回答和待审核计划，点击回到原会话。目标草稿在导航时保留；受理状态未确认时锁定原目标与频率，重试同一请求，避免重复创建。当前未运行不等于业务已经完成。
- **业务复核**：AI 的每次新 CRM/ERP 写入均需 DSH 单次批准，包括联系人和订单草稿。人工组件沿用同一数据库；旧草稿遇到版本变化须明确复核，过期的删除与提交确认自动失效。AI 查询按集合分页读取，保留修订、事务回滚和幂等回执。
- **笔记可靠性**：内置笔记提供目录、Markdown 编辑、今日笔记、链接、反链、标签、搜索与待审差异。每次写入检查最终文件大小，避免保存后无法读取；待审列表加载失败有独立重试入口，不阻塞已加载的笔记。
- **办公资料**：基础 DOCX、XLSX 与 PPTX 可在右侧使用本地 ONLYOFFICE 编辑器编辑、保存并重新打开。关闭、刷新或换文件前检查未保存内容，取消可保留编辑，保存使用编辑器自带按钮。磁盘文件在编辑期间变化时，冲突保存会拒绝覆盖。CSV/TSV 由 AI 工具处理；CRM/ERP 组件供复核和人工接管。
- **桌面体验**：明暗主题使用对应透明 SVG，产品界面统一 ClawMaster 品牌。工作区使用应用内目录选择。思考、记忆注入与命令详情默认收起，审批和错误保持可见。
- **可控更新**：启动只提示新版本；下载与安装分别确认，签名验证失败不能安装。正式版使用 GitHub Latest 通道，已有正式版本禁止覆盖；Linux DEB 使用独立签名的 DEB 更新文件。
- **DSH 组件**：内置 Agent Teams、OpenViking Memory、Routing Suite、Better Sidebar 与 IM 集成。OpenViking 需要单独配置服务，IM 连接需要对应平台登录；安装插件不代表外部账户已连接。

四平台发布包括 Windows x64 NSIS、macOS Apple Silicon/Intel DMG、Linux x64 AppImage/deb，以及 Tauri 更新签名、公钥、`latest.json`、构建来源记录和 `SHA256SUMS.txt`。所有平台构建与安装验收通过后，工作流发布到 [ClawMaster-Desktop](https://github.com/NSIETeam/ClawMaster-Desktop/releases)。macOS 使用临时签名，不含 Apple 公证；Windows 没有发布者证书。

本版面向本地企业工作台，不提供多租户服务或大规模数据库承诺。人工业务快照与开库校验仍读取全量记录。任务草稿在当前前端加载期间保留；退出应用或刷新前请保存。Office 复杂排版、宏、加密与旧版二进制格式不在验收范围内，保留其许可与对应源码入口。macOS 最低版本为 11.0；Linux 沙箱能力由内核功能探测确定。首次启动需要联网准备运行环境和生产依赖。升级前保存编辑、结束任务并备份 DSH 主目录；保留该目录以复用凭证与会话。

## English

ClawMaster WatchDog is a local enterprise collaboration workspace with a Tauri desktop shell and the DSH runtime. It reuses model credentials, conversations, tools, approvals and plugins. The program version is `0.2.0`; the release is named `0.2.0-release`.

- **Task follow-up**: The first-run tutorial covers business goals, responsibilities, acceptance and scheduled checks. The workbench prioritizes pending approvals, questions and plan reviews and opens their existing conversations. Goal drafts survive navigation. Unconfirmed admission locks the original goal and cadence and retries the same request. Not running does not establish business completion.
- **Business review**: Every new AI CRM/ERP mutation requires one-shot DSH approval, including contacts and order drafts. Manual components use the same database. Stale drafts require explicit review, and changed revisions expire deletion and submission confirmations. AI queries read collection-specific pages while retaining revisions, transaction rollback and idempotent receipts.
- **Reliable notes**: The built-in vault provides folders, Markdown editing, daily notes, links, backlinks, tags, search and proposed diffs. Every write checks final file size to keep saved notes readable. Failed proposal loading has its own retry action and does not block successfully loaded notes.
- **Office files**: Basic DOCX, XLSX and PPTX can be edited, saved and reopened in local ONLYOFFICE sidebar editors. Closing, refreshing or switching files checks for unsaved content; cancellation retains edits and saving uses the embedded editor’s button. A conflicting save preserves a file changed on disk during editing. AI tools process CSV/TSV; CRM/ERP components support review and manual takeover.
- **Desktop experience**: Transparent SVG marks match light and dark themes, and product copy uses ClawMaster. Workspace selection uses an in-app directory dialog. Reasoning, memory injection and command details stay collapsed while approvals and errors remain visible.
- **Controlled updates**: Startup only announces availability. Download and installation require separate confirmations, and signature failure prevents installation. Stable versions use GitHub Latest and cannot overwrite existing stable releases. Linux DEB installations use separately signed DEB updates.
- **DSH components**: Includes Agent Teams, OpenViking Memory, Routing Suite, Better Sidebar and IM integration. OpenViking requires a separate service; IM connections require each platform’s login. Installing a plugin does not connect an external account.

The four-platform release includes Windows x64 NSIS, macOS Apple Silicon/Intel DMGs, Linux x64 AppImage/deb, Tauri updater signatures, the public key, `latest.json`, build provenance and `SHA256SUMS.txt`. The workflow publishes to [ClawMaster-Desktop](https://github.com/NSIETeam/ClawMaster-Desktop/releases) after platform builds and installer acceptance pass. macOS uses ad-hoc signing without Apple notarization; Windows has no publisher certificate.

This version targets a local enterprise workspace and does not provide multitenancy or a large-database capacity guarantee. Manual business snapshots and startup validation still read all records. Task drafts last for the current frontend lifetime; save before exiting or refreshing. Complex Office layouts, macros, encrypted files and legacy binary formats remain outside acceptance; legal notices and corresponding-source access remain available. macOS requires 11.0 or later; Linux sandbox availability follows its kernel capability probe. First launch needs network access to prepare runtime and production dependencies. Before upgrading, save edits, finish tasks and back up the DSH home; retain it to reuse credentials and conversations.
