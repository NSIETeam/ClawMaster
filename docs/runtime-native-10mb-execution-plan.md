# Rust 原生微运行时：20MB / 10MB 执行方案（给 Luna）

## 先定结论

当前方案的问题不是压缩参数不够，而是把 Node、agent capsule 和 SQLCipher 当成了桌面安装器的常驻依赖。改用 Rust 原生微运行时后，体积目标拆成两个真实可验收的产物：

- `micro-online`：完整桌面壳、协议桥接、会话、审批、审计和更新，安装器目标 `<=20 MiB`，硬上限 `24 MiB`。
- `micro-bootstrap`：只包含桌面壳、登录/会话引导和远端协议桥接，目标 `<10 MiB`，硬上限 `12 MiB`。它明确要求在线，不宣称具备离线执行能力。

离线执行、浏览器自动化、数据库运行时和本地插件不塞进基础安装器，分别作为签名的 capability bundle 发布。这样才是实际减少安装包，而不是把大文件延迟到首次启动。

## 推荐技术架构

```text
Tauri 2 UI (系统 WebView)
        |
Rust native-runtime
  lifecycle / IPC / policy / audit / update
        |
versioned runtime contract
        |----------------------|
server session gateway      signed capability bundles
                            WASI / browser / offline tools
```

### 基础安装器内保留

- Tauri 2 和前端静态资源；Windows 使用系统 WebView2，不捆绑 Chromium。
- Rust `native-runtime`：启动、单实例、凭据摘要、会话连接、流式事件、审批门禁、审计摘要、更新回滚。
- 现有 `runtime_contracts` 作为唯一 IPC/事件协议，不再通过 Node sidecar 转发。
- TLS、JSON、压缩和签名校验使用 Rust 原生依赖，发布构建启用 `release`, `lto=true`, `strip=true`, `panic=abort`。

### 基础安装器移除

- `node` / `node.exe` 及其 npm 依赖树。
- `agent capsule`、文档 worker 和浏览器运行时。
- `SQLCipher` 动态库；本地基础状态使用 OS keychain 加密的小型状态文件，结构化历史和重型查询放在服务端。
- 任何 Otto 命名、图标、默认资源和兼容层可见字符串。旧环境变量只在迁移代码中保留映射，不进入 UI、安装包元数据或新协议。

### 扩展能力

扩展包使用带版本、SHA-256、签名和最小权限声明的 manifest，按平台和能力独立下载、缓存和回滚。需要本地沙箱时优先采用小型 WASI 引擎（先做 `wasmi` 基准）；不能把 Wasmtime、浏览器或完整 agent 再次静态链接回基础安装器。扩展包不计入 `micro-online` 和 `micro-bootstrap` 的基础安装器体积，但必须单独做下载大小和启动内存验收。

## 体积预算

| 项目 | micro-bootstrap | micro-online |
| --- | ---: | ---: |
| Rust/Tauri 可执行文件 | 4 MiB | 6 MiB |
| 前端静态资源 | 2 MiB | 3 MiB |
| 签名 manifest、迁移和图标 | 0.5 MiB | 1 MiB |
| 安装器压缩及余量 | 2.5 MiB | 9 MiB |
| 目标 / 硬上限 | `<10 / 12 MiB` | `<=20 / 24 MiB` |

预算只是设计约束，不是验收证据。最终以 Windows NSIS、macOS DMG 和实际安装目录的字节数为准；必须同时记录压缩包大小、展开大小和最大常驻内存。

## 给 Luna 的执行顺序

### 第 1 阶段：切断大依赖

1. 在 `packages/desktop/src-tauri/src/native_runtime.rs` 实现 Rust 会话桥接、流式事件、审批和审计最小闭环。
2. 将 renderer/preload 从 Node sidecar 调用切换到 Tauri command/event；保留旧入口只用于迁移测试。
3. 修改 `tauri.conf.json` 和 `prepare-tauri-runtime.mjs`，基础模式禁止复制 Node、agent、SQLCipher、浏览器和 npm 产物。
4. 将 `Cargo.toml` 的依赖分成基础依赖和 capability feature，基础 feature 不允许引入数据库加密库或 WASM 大运行时。

### 第 2 阶段：双产物打包

1. `tauri-runtime-policy.mjs` 增加 `micro-bootstrap`、`micro-online`、`embedded-legacy` 三种显式模式。
2. `embedded-legacy` 只保留回滚用途，禁止进入 beta 默认流水线。
3. 更新 `verify-tauri-bundle.mjs`、Windows installer verifier、DMG verifier 和 smoke 脚本，分别检查资源白名单、实际字节数、架构和运行模式。
4. CI 为两个模式分别上传未签名中间产物、签名安装器、展开目录清单和 size report，避免只测 staging 目录。

### 第 3 阶段：能力与内存边界

1. 首屏必须在无 capability bundle 时可启动，并明确显示在线/离线能力状态。
2. 高风险工具继续经过 policy、confirmation、audit；缺少扩展时返回 typed `capability_unavailable`，不能静默降级。
3. 先测 Rust 基础 agent/session 对象的驻留内存，再测每个可选 capability worker；“每个 agent 不超过 1MB”只对可拆分的 agent 状态/协议对象计量，不能把 WebView、共享 TLS、模型进程或浏览器进程伪装成 agent 内存。
4. 内存测试必须包含空闲、流式响应、审批等待、断线重连和 10 个并发会话五种场景，并输出 RSS/PSS 和对象计数。

### 第 4 阶段：发布 `0.0.2-beta`

只有以下证据全部存在才允许打 beta 标签：

- Windows x64 `micro-online` 安装、启动、登录、会话、审批、审计、更新回滚通过。
- `micro-bootstrap` 实际安装器 `<10 MiB`，`micro-online` 实际安装器 `<=20 MiB`，均未携带 Node、agent capsule、SQLCipher、浏览器或 Otto 资源。
- 每个 agent 状态/协议对象在五种场景下均不超过 1 MiB；超出时阻断发布并给出 top allocation。
- `npm run doctor`、`git diff --check`、focused tests、typecheck、code-map check 和所有 beta release gates 全绿。
- 安装后首次启动不依赖隐式下载；需要扩展时只通过已签名 manifest 下载并可回滚。

## 失败处理与回退

- 20MB 达标但 10MB 不达标：发布 `micro-online`，保留 `micro-bootstrap` 为实验产物，不修改验收口径。
- 协议桥接不稳定：回退到 `embedded-legacy` 做诊断，不把 legacy 重新设为 beta 默认模式。
- 任一扩展包过大或内存超限：拆分能力或移到服务端，禁止回填基础安装器。
- 任一平台实际安装器超限：阻断标签创建，保留 size report 和构成清单，直到找到可复现的 top contributor。

## 不可接受的伪优化

- 只减少 staging 目录，不测最终 NSIS/DMG。
- 安装器很小但首次启动静默下载完整 runtime。
- 用共享进程平均值掩盖单个 agent 超过 1 MiB。
- 只删除字符串搜索命中的 Otto 文本，却保留旧 logo、资源文件名或安装器元数据。

这条路线的关键判断是：20MB 是基础在线产品的发布目标，10MB 是不带本地执行能力的 bootstrap 目标；完整能力必须模块化，不能同时要求单文件离线全功能和 10MB 安装器。
