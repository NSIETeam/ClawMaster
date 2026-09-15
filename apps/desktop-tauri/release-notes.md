# ClawMaster WatchDog 0.2.2

## 中文

开启AI时代的企业协作。ClawMaster 0.2.2 为桌面更新通道、经过授权的微信读取和本地执行组件提供完整的安装支持，继续复用 DSH 的会话、模型凭证、工具及审批。

- **每次授权的微信读取（macOS）**：AI 可请求读取用户指定、已在微信中选中的聊天。每次执行都单独申请批准，批准前不启动读取程序；拒绝、取消或参数变化均不能继续。只读取该聊天当前可见的有限条消息；标题不匹配或界面结构无法确认时拒绝读取。消息会进入当前会话及用户配置的模型，用于本次任务。
- **服务器更新通道**：桌面优先从 ClawMaster 更新服务器检查原生版本，GitHub 作为备用来源。内置 `/updates`、只读检查工具及经过批准的组件准备入口。后台检查只查询更新信息；组件修改、下载和原生安装遵守各自的批准流程。签名或摘要不匹配的文件不能安装。
- **旧版更新组件兼容**：已通过更新接入包安装的更新器不会因桌面升级而重复注册；已有配置及停用选择保留。更新器自身更新仍只暂存，不能把暂存或一次重启描述为已经替换成功。
- **本地执行组件修复**：安装包包含与操作系统和架构匹配的 RPA 原生执行程序，校验产物和实际调用路径。缺失程序不能通过发布验收。取消、超时和输出超限会终止本次子进程并等待退出；子进程不继承模型密钥等敏感环境变量。
- **Windows 与 Linux 修复**：内置更新组件 0.1.1 修复 Windows 重复下载的缓存复用，并在归档路径被系统规范化之前检查原始路径。Linux 本地执行记录通过系统 Secret Service 保存加密密钥，可供后续进程读取；系统可能要求解锁密钥服务，访问失败时明确报错。已有单独安装的更新组件保留其版本与配置，不被桌面升级静默替换。
- **macOS 窗口控件**：关闭、最小化和缩放按钮保留在独立的系统标题栏区域，会话、侧栏与插件内容从下方开始，避免遮挡操作。标题栏跟随系统外观，内容区域继续使用应用选择的主题。
- **保留已有修复**：延续 0.2.1 的笔记批注与写入保护、Graph Memory 输出校验、WatchDog 业务审批、Office 保存冲突保护、Windows 路径处理及关闭后重新启动的修复。

微信读取作为试用功能提供，需要已登录的 macOS 微信和系统辅助功能权限；隔离测试不代表已验证用户所安装微信版本的真实读取。本版不提供 Windows/Linux 个人微信读取、后台监听、全量历史读取或微信发送能力。读取界面上的可见消息不等于完整聊天记录；未识别的微信界面会明确报告不可用。现有 IM 机器人连接仍是独立功能，需要相应平台登录。

桌面安装包覆盖 Windows x64、macOS Apple Silicon/Intel，以及 Linux x64 AppImage/deb。每个平台保留构建来源、安装包摘要及更新签名。macOS 使用临时签名，未经过 Apple 公证；Windows 没有发布者证书。首次启动仍需联网准备运行环境及生产依赖。升级前保存编辑并结束正在执行的任务；保留 DSH 主目录即可继续使用原有凭证、设置和会话。

## English

ClawMaster 0.2.2 adds installed-desktop support for the server update channel, approved WeChat reads and the native execution component. It continues to reuse DSH conversations, model credentials, tools and approvals.

- **Per-call WeChat approval on macOS**: The AI can request a named conversation already selected in WeChat. Every execution asks for separate approval before starting the reader. Rejection, cancellation or changed arguments prevents execution. Reads are bounded to currently visible messages in that conversation; an unmatched title or unrecognized interface rejects the read. Returned messages enter the current session and the user's configured model for the requested task.
- **Server update channel**: Native checks prefer the ClawMaster update server with GitHub as a fallback. The desktop includes `/updates`, a read-only inspection tool and approved component preparation. Background checks fetch metadata only. Component changes, downloads and native installation retain their respective approval steps. Signature or digest failures prevent installation.
- **Compatibility with the portable update kit**: Desktop upgrades do not register a second updater when one is already installed through the kit. Existing configuration and disabled choices remain intact. Self-updates remain staged; staging or restarting alone does not establish replacement.
- **Native execution packaging**: Installers include the RPA executable for their operating system and architecture, with artifact and invocation checks. Missing executables cannot pass release acceptance. Cancellation, timeouts and output limits terminate the owned child and wait for exit. Children do not inherit model credentials or other sensitive environment variables.
- **Windows and Linux fixes**: Bundled updater 0.1.1 reuses authenticated download-cache entries on Windows and validates original archive paths before platform normalization. Linux native execution records use the system Secret Service to retain encryption keys across processes; the system may request unlocking, and service-access failures report an error. Previously installed standalone updaters retain their own version and configuration rather than being silently replaced by a desktop upgrade.
- **macOS window controls**: Close, minimize and zoom buttons occupy a separate system title-bar area. Conversations, sidebars and plugin content start below it, keeping their actions unobstructed. The title bar follows system appearance while content keeps the selected application theme.
- **Preserved fixes**: Retains 0.2.1 note annotations and write protection, Graph Memory output validation, WatchDog business approvals, Office save-conflict protection, Windows path handling and relaunch fixes.

WeChat reading is an experimental feature requiring a logged-in macOS WeChat client and system Accessibility permission; isolated tests do not establish live reading on the user's installed WeChat version. This release does not provide personal WeChat reads on Windows/Linux, background listening, complete history extraction or WeChat sending. Visible messages are not a complete transcript; unrecognized WeChat interfaces report unavailability. Existing IM robot connections remain separate and require the corresponding platform login.

Desktop installers cover Windows x64, macOS Apple Silicon/Intel and Linux x64 AppImage/deb. Each platform retains build provenance, artifact checksums and updater signatures. macOS uses ad-hoc signing without Apple notarization; Windows has no publisher certificate. First launch still requires network access to prepare runtime and production dependencies. Save edits and finish running tasks before upgrading; retain the DSH home to reuse credentials, settings and conversations.
