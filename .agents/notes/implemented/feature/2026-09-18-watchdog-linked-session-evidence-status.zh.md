# Agent Note：WatchDog 已关联 Session 的证据状态

Status: implemented

[English](2026-09-18-watchdog-linked-session-evidence-status.md) | 中文

## 问题

WatchDog 将任务证据保存为提交者提供的位置。位置可能失效，但解析任意路径或 URL 会让服务越过任务授权读取文件，或向授权范围外的地址发起服务器请求。

## 决策

任务表单可以用 `dsh-session://<sessionId>` 引用已关联的 Session。任务读取只解析这种引用。Host 要求 Session ID 出现在任务的关联会话中；企业模式还会按当前 Session 身份检查它是否获准读取同一组织和主体下的任务。Host 通过实时 Session 注册表确认会话存在，或只读打开后立即关闭持久化 Session；不会读取 Session 事件。

响应携带可选的、仅在读取时计算的 `evidenceAvailability`，不会持久化该值。Session 缺失或未关联时标为 `unavailable`；权限拒绝也标为 `unavailable`。其他位置（包括外部 URL、本地文件和自由文本）保持 `unchecked`。意外的存储或权威服务故障也保持 `unchecked`，因此证据解析不会导致任务服务不可用。Host 不会对证据位置发起网络请求。如果添加状态会超出配置的响应字节预算，Host 会省略计算字段，客户端按 `unchecked` 显示。

`available` 表示获准访问的任务关联 Session 存在，不代表 Session 内容或业务结论已经核实；验收前仍须由人工检查。历史任务修订会按当前 Session 和权限状态重新解析。

## 考虑过的替代方案

**抓取提交的 URL 以检查状态或内容。** 这可能访问内网服务、泄露凭据或暴露服务器本地资源，因此 Host 不会解析这些 URL。

**所有位置都标记为未核验。** 这虽然避免网络访问，却无法识别 Host 能用现有授权和持久化服务验证的缺失 Session。

**把可用性与证据一同持久化。** Session 是否存在以及当前授权会变化，保存的结果会过期并错误描述当前访问状态。

## 结果

任务证据仍使用原有持久化格式；只有响应记录增加可选的计算字段。DSH Session 引用可以直接解析，表单也只允许选择已关联到任务的 Session。其他文件附件仍需要单独受治理的存储和读取能力。

## 验证

`frontends/dsh/tests/watchdog-tasks.test.mjs` 通过已注册的认证任务路由验证持久化 Session 可用、Session 缺失，以及外部 URL 不会被解析。`frontends/dsh/tests/task-board.client.spec.mjs` 验证 Session 引用选择和可用性提示。本地授权模式已有覆盖；企业授权行为仍需在部署时通过身份提供方验收。
