# ClawMaster DSH 前端

`@clawmaster/dsh-frontend` 是现有 DeepSeek Harness Web Host 的外置前端插件。
它把 ClawMaster 产品化为企业 WatchDog：增加品牌、配色和监控工作台，使用 DSH 已有客户端服务；后台零迁移。
Agent、模型、工具、插件执行、审批、会话存储和恢复继续由原 DSH 负责。

## 当前功能与兼容范围

- 侧栏与对话首页的 ClawMaster 标识，适配明暗主题。
- 工作台展示实际 DSH 会话，支持搜索、进行中筛选、刷新、新建和重新打开会话。
- Host 会在 `$DSH_HOME/watchdog-workspaces/managed` 创建 WatchDog 托管空间；“启动 WatchDog”自动绑定该空间，不继承用户当前或最近工作空间。
- 内置数据处理器可解析和预览 CSV/TSV；CRM 客户跟进和 ERP 库存台账提供本机持久化 CRUD，低库存自动标记。
- 默认组合 `dsh-better-sidebar@0.19.1`，在会话右侧提供 CodeMirror 文档/代码编辑器、文件预览、沙箱网页浏览器、终端、Git 与任务面板。
- 默认启用 DSH 官方 Goal 续跑链路，并在本 bundle 中启用官方 Schedule、时区上下文和提醒目录，用于固定间隔巡检与同会话提醒。
- 展示真实连接状态；空白、已归档及子代理会话不进入近期任务列表。
- 对话、审批、工具调用与结果、模型和插件设置视图继续使用原 DSH 界面。
  工作台提供设置位置说明，当前没有另造模型或插件管理后台。

当前支持和核验基线为 **DSH `0.1.5-rc.2`**，Cordis peer 为 `4.0.2`。
本插件消费公开 `slots`、`theme`、`sessions`、`workspaces`、`connection`、`uiWorkspace` 服务。
兼容声明仅覆盖本插件使用的服务和实际验证的页面，未宣称所有 DSH 插件均已测试。
新增企业功能应调用已有接口；本版本未增加企业后端、Rust 宿主桥或凭据 provider。

浏览器标签、桌面标题栏、启动页和页面内品牌均显示 ClawMaster。对话首页标题通过精确匹配上游中英文标题进行替换；升级 DSH 后需进行可见界面回归。
本包也不打包 Node、DSH 后台或桌面安装器，没有 10 MiB 安装包承诺。

## 开发、检查与打包

使用现有 DSH 支持的 Node：`^22.19.0 || >=24.0.0`，推荐与运行 DSH 的版本一致。
下列命令在本目录执行；这是独立前端包，不需要构建整个 ClawMaster 仓库。

```sh
cd /Users/king/Documents/ChatGPT/ClawMaster/frontends/dsh
npm ci
npm run typecheck
npm test
npm pack
```

`npm test` 先构建，再运行三个自动化测试：会话数据映射、连接状态、打包后的客户端注册与卸载。
这些测试不调用模型，也不能替代真实浏览器、审批或插件组合验收。
单独构建可运行 `npm run build`；`npm pack` 的 `prepack` 也会重新构建。
当前版本生成 `clawmaster-dsh-frontend-0.3.1.tgz`，内含客户端 bundle、托管空间 Host 入口和 profile patch。
包标记为 private，可本地打包安装，不通过这些命令发布到 npm。

## 安装到现有 DSH

命令假设当前 shell 能执行已有的 `dsh`，且 `pnpm` 在 `PATH` 中。
`dsh plugin` 实际把 `add` / `remove` 等参数传给 profile 目录内的 pnpm，并自动维护 bundle 列表。
若 DSH 来自项目内安装，也可用其 `node_modules/.bin/dsh` 的绝对路径替换命令名。

首次建立尚不存在的 `clawmaster` profile 时，先从官方 Web 模板创建；以下命令只打印配置，不启动模型：

```sh
dsh --profile clawmaster --from-default-profile web --dump-default-config
```

已有 `clawmaster` profile 时跳过此步，并确认其已经包含 `dsh-base` 与 `dsh-web-app`。
不要直接对尚不存在的自定义 profile 执行插件安装后假定它有 Web UI：`dsh plugin` 默认只创建 base profile。
已有 DSH 使用自定义 `DSH_HOME` 时，所有命令沿用同一设置。

安装已构建的本地包，再启动或重启该 profile：

```sh
dsh plugin --profile web add /Users/king/Documents/ChatGPT/ClawMaster/frontends/dsh/clawmaster-dsh-frontend-0.3.1.tgz --ignore-scripts
dsh plugin --profile web add dsh-better-sidebar@0.19.1
dsh --profile clawmaster --host 127.0.0.1 --port 0 --no-open
```

Better Sidebar 的终端依赖 `node-pty` 原生构建；pnpm 首次拦截其构建脚本时，应先审阅后通过 `pnpm approve-builds` 只批准 `node-pty`，再重跑插件安装。默认设置保留工作区路径围栏与网页 iframe 沙箱，模型终端工具默认关闭。

在其他目录构建时，将 tgz 参数换成实际绝对路径。`--ignore-scripts` 适用于这里已经包含构建产物的包。
`--port 0` 让系统分配空闲端口；用 DSH 输出的认证入口打开页面，不把 token URL 写入文档或分享。
在侧栏选择“工作台”，即可查看本插件页面；原会话和设置入口继续可用。

安装会启用包内 `cordis.patch.yml`：禁用官方品牌展示行、插入本前端插件，并启用 DSH 官方 Schedule 与 time-context。
DSH 的其他 Host、工具、存储及业务插件行保持原配置；Goal 与 goal-round-driver 已由 DSH base 默认提供。
移除此界面扩展可执行下列命令并重启 profile；无需删除会话数据：

```sh
dsh plugin --profile clawmaster remove @clawmaster/dsh-frontend
```

2026-09-12 已在独立 `DSH_HOME` / `DSH_AGENTS_HOME` 中实际验证首次 profile 创建、
`npm pack`、官方 CLI 安装本地 tgz 和配置导出。导出差异仅为禁用官方品牌行及新增本插件，
其他插件配置保留；这项安装验证没有启动模型。

## 源码入口

| 文件 | 职责 |
| --- | --- |
| `src/client.tsx` | 注册品牌、主题及工作台插槽，订阅官方服务 |
| `src/Workbench.tsx` / `src/styles.css` | 工作台呈现、筛选、刷新状态与响应式样式 |
| `src/services.ts` | 使用到的服务类型及只读会话展示映射 |
| `src/host.ts` | 创建并登记 WatchDog 托管工作空间 |
| `scripts/build.mjs` | 生成官方 ModuleLoader 客户端 factory；React 使用 Host 的共享实例 |
| `cordis.patch.yml` | 前端 profile 组合，不实现后台逻辑 |

本包许可证为 Apache-2.0；DSH 及各第三方组件保留各自许可证。
DSH 接口与 CLI 参考：[官方源码](https://github.com/deepseek-ai/deepseek-harness/tree/c291e7961a515f6d7af9304e7fd1d257929aef26)、[profile 插件管理](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/apps/cli/src/plugin.ts)。
