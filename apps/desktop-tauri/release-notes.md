# ClawMaster WatchDog 0.0.1

## 中文

开启 AI 时代的企业协作。WatchDog 0.0.1 集中修复企业任务治理、组件故障隔离、桌面凭据迁移和更新恢复中的可靠性问题，让单个可选能力不可用时核心应用仍能打开并继续工作。

macOS 或 Windows 首次安装可能显示系统安全提示。下载前请先阅读[首次启动安全提示处理教程](https://github.com/NSIETeam/ClawMaster/blob/desktop-v0.0.1/docs/user/guide/desktop-first-launch-security-warnings.zh.md)，核对安装包后再决定是否继续。

- **企业任务与权限**：加强任务状态回执、重试幂等、审计责任归属、审批绑定和恢复冲突保护；工作区分配会在写入前重新核对权限与资源状态。
- **运行状态与调度恢复**：补充 WatchDog 状态胶囊、队列和调度故障可见性、容量准入约束及恢复后的一致性校验。
- **组件故障隔离**：可选客户端改为后台启动并传递动态模块及服务依赖；损坏的工具 schema 按工具隔离，不影响其他可用工具或主界面。认证、权限、审批、Guard 与主前端仍保持必需。
- **模型工具兼容**：RPA 与微信读取工具现在向模型 API 暴露完整的 JSON Schema object 定义，避免单个组件的函数声明不合规导致整轮模型请求失败。
- **桌面凭据与更新**：修复 OS 安全凭据通道在混合协议大帧、启动握手和热重载中的问题；旧更新器迁移保留通道和停用偏好，并把无法确认加载的旧版本准确标记为未验证。
- **可用性与平台**：改善 Windows Host 启动及进程恢复，继续提供 Apple Silicon macOS、Windows x64、Linux x64 桌面构建。

原生桌面 RPA 执行本版仍未启用；相关操作会报告不可用，不作为本版已支持能力。正式发布还需要通过仓库要求的跨平台安装验收；本次版本标签仅触发构建，不会自动创建公开 Release。

## English

ClawMaster WatchDog 0.0.1 opens the era of AI-powered enterprise collaboration. This release strengthens enterprise task governance, optional-component isolation, desktop credential migration and update recovery so an unavailable optional capability does not prevent the core application from opening and working.

macOS or Windows may show a security warning during first installation. Before downloading, read the [first-launch security warning guide](https://github.com/NSIETeam/ClawMaster/blob/desktop-v0.0.1/docs/user/guide/desktop-first-launch-security-warnings.md), verify the installer, and then decide whether to continue.

- **Enterprise tasks and permissions**: Improve task outcome receipts, retry idempotency, audit responsibility, approval binding and recovery conflict protection. Workspace allocation rechecks permissions and resource state before writes.
- **Runtime status and schedule recovery**: Add WatchDog state capsules, visible queue and scheduler failures, capacity admission controls and consistency checks after recovery.
- **Component isolation**: Optional clients start in the background with dynamic-module and service dependencies propagated. A malformed tool schema is isolated to that tool, leaving other available tools and the main UI usable. Authentication, permissions, approvals, Guard and the main frontend remain required.
- **Model tool compatibility**: RPA and WeChat tools now expose complete JSON Schema object definitions to model APIs, preventing one invalid optional function declaration from rejecting the whole request.
- **Desktop credentials and updates**: Fix OS secure-credential transport across mixed-protocol large frames, startup handshakes and hot reload. Legacy updater migrations preserve channel and disabled preferences and accurately mark older selections whose activation cannot be confirmed.
- **Availability and platforms**: Improve Windows Host startup and process recovery; desktop builds continue to target Apple Silicon macOS, Windows x64 and Linux x64.

Native desktop RPA execution remains disabled in this release; affected actions report unavailable and are not presented as supported. A public stable release still requires the repository's cross-platform installation acceptance. This version tag starts a build only and does not automatically publish a GitHub Release.
