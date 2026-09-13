# Agent Note: 按需查看 ClawMaster 过程详情

Status: implemented

[English](2026-09-13-clawmaster-process-disclosures.md) | 中文

## Problem

企业用户需要查看任务结果和可处理的失败，无需阅读技术过程文本。只收起正文却保留思考、记忆或命令预览，仍会在对话中露出这些内容。

## Decision

现有 ClawMaster 构建配置从收起的标题中省略思考和上下文预览，以及 Shell/代码摘要。来源名称和简短错误摘要继续可见。现有展开控件保留全部可用输入和输出；后台 Shell 回执也能展开。React 状态记录已挂载行的手动展开状态，不通过 effect 在流式更新或完成时重置。现有已完成 Turn 分组继续负责整组过程折叠。

展示不修改 Session 事件、模型输入、最终回答或审批控件。其他 DSH 构建保留现有预览。[桌面壳决策](2026-09-12-clawmaster-shell-over-dsh.zh.md)定义产品与运行时的分工；[Chat](../../../../packages/client/ui-chat/README.zh.md) 和 [Tool](../../../../packages/client/ui-tool/README.zh.md) 参考文档定义组件行为。

## Alternatives considered

**通过 CSS 隐藏预览。** 隐藏的技术文本仍存在于渲染内容中，仍可能影响无障碍访问或搜索。

**每次内容变化都重置展开状态。** 流式更新会收起用户主动打开的详情。

## Consequences

用户主动打开技术详情。展开状态属于本地 UI 状态，不是在重新加载后保留的偏好。收起的错误行仍能识别失败，而不露出原始 stderr 或堆栈。

## Verification

组件测试覆盖默认收起、更新期间保留手动展开、后台回执、终端失败退出、普通结果摘要和未改变的 DSH 预览。英文和中文渲染文本快照固定收起的标题。现有 Chat 测试继续覆盖最终回答和审批展示。
