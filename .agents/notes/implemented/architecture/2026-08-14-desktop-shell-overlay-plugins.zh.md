# Agent Note: 桌面壳标题栏与 overlay 插件

Status: implemented

[English](2026-08-14-desktop-shell-overlay-plugins.md) | 中文

## 问题

桌面 fork 必须提供窗口标题栏、托盘、签名更新和任务完成提醒，同时不能修改上游 Harness 包。后续同步应原样拉取 `packages/`、`apps/cli` 和 `apps/web`。必须观察 Host session 事件的功能不能只放在 WebView 里，因为那会改已发布的 web 客户端。

## 决策

上游终端模拟器负责光标查询应答及其异步完成。桌面分支移除固定坐标应答，使每次查询只获得一个响应，且就绪判定等待响应完成。

**内容使用独立的原生 WebView。** 跨站 iframe 无法保留 Host 的 `SameSite=Strict` 登录 cookie。监督器只从子进程 stdout 接收预期回环来源及单个非空令牌，验证 cookie 交换重定向但不跟随，再把地址交给内容 WebView，且不记入日志。本地标题栏保留自己的 WebView 和权限，远程内容不获得原生窗口权限。关闭对话框暂时隐藏内容，防止内容遮住对话框。原生和 WSL 命令均把启动器 patch 参数放在 `--no-open` 等 Web 参数之前。Tauri 的 `unstable` 特性启用现有多 WebView API；平台打包和真实窗口启动仍是必要验证。

**原生窗口控件留在 `apps/desktop-tauri`。** 主窗口使用系统装饰；macOS 隐藏标题文字并为交通灯预留空间。启动页使用 ClawMaster 标志并跟随系统外观。本地 `shell.html` 负责首次关闭选择，并将其写入平台应用数据目录的 `DeepSeek Harness/desktop-settings.json`。关闭遵循已保存偏好；托盘可修改偏好、显示窗口、重启或退出。隐藏时 Host 继续运行。退出、重启和更新安装在退出前停止所属 Host 进程树。Windows 使用 `KILL_ON_JOB_CLOSE` Job 回收后代进程。重新打开 macOS 应用会显示已有的隐藏窗口。系统负责窗口外观，嵌入客户端负责所选 Web 主题。

**与 Host 的协作是 overlay 插件，不是改包。** 外壳把 `overlay/desktop-notify/index.mjs` 复制到 `$DSH_HOME/desktop-overlay`，写入插件 `name` 为 `file://` URL 的 `--patch` 列表，再启动 `dsh web --patch <该文件>`。Windows 盘符路径（如 `C:/...`）不是合法 ESM specifier——Node 会把 `C:` 当成 URL scheme——因此 overlay 必须写成 `file:///C:/...`（空格做百分号编码）。插件监听 `session/event` 中 `turn/end` 且 `reason.kind === 'completed'`，并向 `DSH_DESKTOP_NOTIFY_URL` 给出的本机通知 URL 发送 POST。Rust 监听端只在主窗口不在前台时弹出系统通知并播放 `sounds/complete.wav`。

**更新使用带签名的 Tauri updater。** [正式更新决策](2026-09-13-desktop-stable-confirmed-updates.zh.md)负责通道选择及下载、安装的分别确认。启动在主窗口打开后检查，仅提示有可用版本；网络失败不拖住启动页。

这是对[跨平台桌面源码预配](../feature/2026-08-14-cross-platform-desktop-source-provisioning.zh.md)的延伸，并不把桌面行为移进 `packages/`。

## 曾考虑的替代方案

**改 `apps/web` 或某个 `packages/*` 插件。** 不采用：每次同步上游都要重做或丢失桌面行为。overlay 改用文档中的 `--patch` 层。

**直接写 `$DSH_HOME/cordis.patch.yml`。** 不采用：该文件是用户的 home 级 patch 层。生成独立的 `--patch` 文件，把 home 文件留给用户。

**把标题栏注入 React DOM。** 不采用：这会让标题栏耦合 web 客户端标记，且仍无法拥有托盘、更新或操作系统通知。

**标题栏关闭按钮一律退出。** 不采用：编码会话不应因误点关闭而结束；第一次关闭会询问，之后由已保存偏好和托盘负责进程生命周期。

**关闭一律隐藏且不再询问。** 不采用：有人希望关闭即退出；托盘缺失时隐藏看起来像崩溃。

## 后果

上游框架目录不再包含仅桌面使用的插件行。缺少 overlay 文件时 Host 启动会明确失败。用户已有的 home `cordis.patch.yml` 保持不动。窗口在前台时的 turn 不弹通知、不播放完成音。`apps/desktop-tauri/screenshots/` 中的截图用于说明外壳外观，不是从实况会话录制。
