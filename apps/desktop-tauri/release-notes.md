# ClawMaster WatchDog 0.2.3

## 中文

开启 AI 时代的企业协作。ClawMaster WatchDog 0.2.3 加强了企业任务从提交、分派、审批到验收的可追溯流程，并完善桌面运行时的资源控制和进程恢复。

- **WatchDog 任务与调度**：管理业务任务、负责人、期限、待审批事项和结果；调度记录可分页查看，命令回执与任务状态用于恢复和核对。执行仍受在线状态、授权和审批约束。
- **企业治理与审计**：在解析责任归属前验证写入权限；核对权威服务响应；在审计记录中关联操作者、审批和命令回执，降低恢复覆盖责任历史的风险。
- **备份与数据处理**：改进备份工作器的交付与恢复时序；分页读取并限制业务结果和命令输出，避免把整个数据集反复装入页面。
- **桌面资源与进程安全**：按进程树限制后台任务准入和资源预算；改进 Windows Host 身份采集与启动恢复；防止过期清理操作误杀复用 PID 的进程。
- **外壳安全**：收紧打包外壳的内容安全策略及原生权限范围，避免外部内容获得桌面原生命令。

桌面支持包覆盖 Windows x64、macOS Apple Silicon 与 Linux x64。macOS Developer ID 公证和 Windows Authenticode 发布者签名需要对应证书；Tauri 更新签名不等于操作系统发布者签名。此桌面版本与独立 Android 应用分别构建、签名和验收；不要将桌面包或临时 Android 验证签名当作 Android 更新包。

## English

ClawMaster WatchDog 0.2.3 strengthens traceability from business-task admission through assignment, approval and review, and improves desktop resource controls and process recovery.

- **WatchDog tasks and schedules**: Track business tasks, owners, deadlines, pending approvals and outcomes. Schedule history is paginated, and durable command receipts and task states support recovery and review. Execution remains subject to agent availability, authorization and approval.
- **Governance and audit**: Validate write authority before resolving responsibility, validate authority-service responses, and associate operators, approvals and command receipts in audit records.
- **Backup and data handling**: Improve backup-worker delivery and recovery ordering. Paginate business results and bound command output to avoid repeatedly loading entire datasets into the UI.
- **Desktop resource and process safety**: Bound background admission and resource budgets across process trees; improve Windows Host identity capture and startup recovery; prevent stale cleanup from terminating a process after PID reuse.
- **Shell security**: Tighten the packaged shell content-security policy and native permission scope so external content cannot access desktop commands.

Desktop packages target Windows x64, Apple Silicon macOS and Linux x64. Developer ID notarization and Windows Authenticode publisher signing require their respective certificates; a Tauri updater signature is not an operating-system publisher signature. The desktop and standalone Android app have separate build, signing and acceptance paths. A desktop package or a temporary Android validation signature is not an Android update package.
