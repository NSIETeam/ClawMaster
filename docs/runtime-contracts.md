# Runtime Contracts（桌面侧 Rust 合同）

文档作用：统一 `packages/desktop/src-tauri/src/runtime_contracts.rs` 与桌面 invoke 的语义边界，避免 runtime 语义逐层漂移。

## 当前可用入口

- Tauri command: `runtime_contract_version`
- 返回值：`RuntimeContractVersion`
- 值：`protocol = 1.0.0`, `eventSchema = 1`

该命令在运行时启动后可直接读取，用于 UI/测试/升级逻辑确认运行时协议兼容。当前值定义于
`runtime_contracts::RuntimeContractVersion::CURRENT`。

## 结构总览

- `RuntimeRequest`
  - `Initialize`
  - `CreateSession`
  - `ResumeSession`
  - `Prompt`
  - `Cancel`
  - `CloseSession`
  - `ForkSession`
  - `ApprovalRespond`
- `RuntimeResponse`
  - `Initialized`
  - `SessionCreated`
  - `PromptAccepted`
  - `Ok`
  - `Error`
- `RuntimeEvent`
  - `SessionCreated`
  - `RuntimeError`
  - `ApprovalRequested`
  - `UserMessage`
- `RuntimeEventEnvelope`
  - `eventId`, `sessionId`, `sequence`, `timestampMs`, `schemaVersion`,
    `turnId`, `stepId`, `actor`, `traceId`, `payload`, `ignorable`

## 当前阶段限制

1. 仅提供最小契约骨架，不代表功能完整。
2. `contractVersion` 仍保留原有 `runtime_diagnostic` 下旧 `u8` 表示（暂不混淆）。
3. 事件类型、请求体、错误码将按主计划在下一阶段按 `session runtime + projection` 的实现继续补齐。

## 下一步预期动作

1. 把 `runtime_diagnostic` 与 `runtime_contract_version` 的输出并入 `runtime_native` 诊断页。
2. 用 `RuntimeRequest/Response` 包装桌面与原生 sidecar 的边界。
3. 在协议不兼容时，renderer 侧执行降级提示与不可用入口。
