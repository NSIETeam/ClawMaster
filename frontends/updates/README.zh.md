---
description: "在现有 DSH profile 中检查已签名的 ClawMaster 组件版本、批准组件激活，并准备经过验证的桌面更新文件。"
kind: "package-reference"
---

# ClawMaster 更新

[English](README.md) | 中文

## 概述

ClawMaster 可以从服务器检查已签名的组件版本，无须替换桌面应用。你可以批准所选更新，并在现有 DSH web profile 中激活符合条件的组件。后台检查仅仅读取更新信息。更新器自身的更新需要在 Host 停止后安装；原生应用和 DSH 核心更新仍需桌面安装器。

## 目录

- [使用此包](#use-this-package)
- [配置](#configuration)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

此插件挂载到现有 DSH web profile。它未声明 `dsh.bundle.patch`；仅将其安装为包依赖不会激活插件。一次性运行的[首次安装工具](src/install.ts)选择一个 DSH 主目录和运行时根目录，校验组件目录，并在能够修改该 profile 前展示计划。

操作人员使用已验证更新器分发包中的 `install.mjs`，并指定 `--dsh-home` 与 `--runtime-root`。未加 `--yes` 时，工具读取运行时信息和已签名的目录，返回所选版本、摘要、大小及 profile 修订号，不下载组件或修改文件。确认该计划时，追加 `--yes --expected-sha256 <plan.sha256> --expected-patch-revision <plan.expectedPatchRevision>`。候选摘要或 profile 修订号改变时，安装会在写入文件前被拒绝。工具拒绝替换已有更新器配置行或已声明的更新器依赖。

确认安装后，工具在所选 profile 的 `cordis.patch.yml` 中添加更新器所属配置行。监视该 profile 的运行中 Host 可在不重启桌面的情况下加载该行。返回的 `activation-pending` 不代表加载成功：应先确认该 Host 中可使用 `/updates`，再视为安装完成。工具既不启动另一个 DSH 应用，也不修改已安装 `0.2.1` 桌面编译内置的原生更新端点。

使用 `/updates`，或请 agent（智能体）使用 `clawmaster_updates` 查看当前更新信息。两个入口都不下载产物或修改文件。准备所选更新时，agent 使用 `clawmaster_update` 指定类型和版本，组件类还需指定组件 id。一次批准覆盖所展示的具体操作：热更新组件会下载、校验、安装并提交给 Loader；须重启组件会下载、校验并暂存。批准前已固定所选字节及 profile 修订号。

对于符合条件的热更新组件，激活仅修改它所属的 profile 配置行，并返回回滚令牌。是否真正加载成功由 Loader 观测确定。profile 修订号改变时，激活或维护者回滚会被拒绝，避免覆盖期间发生的编辑。标为 `restart` 的组件，包括 `updates` 自身，只会暂存，不修改被监视的 profile：仅重启应用不会应用该暂存变更。

-----

<a id="configuration"></a>
## 配置

[配置 schema](src/config.ts)负责可接受字段及默认值。[首次安装工具](src/installer.ts)固定生产组件端点与公钥。运行时兼容性以所选 Host 的 DSH 版本为准；已签名归档还必须包含它声明的依赖，并匹配共享的 Host 包版本。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `DSH_HOME`，否则为 `~/.dsh` | 所选现有 Host 主目录；更新请求不能覆盖它。 |
| `catalogUrl` | `https://8.140.52.117/updates/clawmaster/components/catalog.json` | 已签名的组件元数据。 |
| `nativeManifestUrl` | `https://8.140.52.117/updates/clawmaster/latest.json` | 原生桌面版本元数据。 |
| `publicKeyPem`, `nativePublicKey` | 随包提供的组件及 Tauri 公钥 | 两类产物各自独立的信任密钥。 |
| `checkIntervalMs` | `60000` | 自动元数据检查间隔；`0` 关闭自动检查。 |
| `nativeTarget` | 观测到的平台及安装类型 | Host 无法确定安装器类型时须明确配置。 |
| `locale` | `zh-CN` | 命令及批准提示语言；也接受 `en-US`。 |

轮询仅读取元数据。网络失败显示为通道信息不可用，另一通道仍可检查。插件 dispose（资源释放）会取消并等待其检查及更新操作。请求、下载及归档限制可在同一 schema 中配置；profile patch 的安全上限固定为 2 MiB。

更新器所属文件位于 `DSH_HOME/clawmaster-updates/` 下。版本目录不可变；下载摘要标识缓存字节。profile 编辑范围限定为 `DSH_HOME/profiles/web/cordis.patch.yml`。现有会话、凭据及无关 profile 配置行不属于更新目标。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[目录读取器](src/catalog.ts)先验证针对目录原始字节的分离式 Ed25519 签名，再接受其 schema。它固定公钥、要求 HTTPS、拒绝重定向，并将组件产物 URL 限制在配置的来源及组件产物路径下。已签名描述符标识各版本、兼容 DSH 版本、激活方式、字节数及 SHA-256 摘要。[下载助手](src/download.ts)在发布已验证的缓存文件前执行请求及字节限制。

[组件安装器](src/components.ts)在解压前验证归档，仅接受普通包文件及目录，拒绝不安全路径、链接、重复路径及不完整的依赖闭包。它不运行 npm 生命周期脚本。安装会记录文件哈希；激活时重新校验这些哈希，并使用文件锁及已查看的 profile 修订号。仅在后继修订号仍匹配时，回滚才恢复记录的前一版 profile。

[首次挂载逻辑](src/bootstrap.ts)允许在 Host 运行中首次挂载更新器，但不能替换已存在的更新器。对于须重启组件的常规更新，操作记录保留为待处理状态，等待另行在 Host 停止后安装。这避免更新器在自身操作尚未结束时卸载自身。导出的 `rollbackComponent` API 用于维护者确认后的恢复操作，不通过命令或 agent 工具开放。

[原生下载助手](src/native.ts)在可取消的 worker 中，通过现有 Tauri Minisign 公钥验证桌面产物。它返回 `requires-native-installer`，从不启动安装器。提供原生 manifest（元数据清单）、下载已认证文件及安装该文件是彼此独立的结果。

组件发布依次使用[构建](scripts/build.mjs)、[打包](scripts/pack.mjs)、[离线签名](scripts/sign-catalog.mjs)及[服务器发布](scripts/publish-catalog.mjs)脚本。签名器认证目录，并在比对归档内安装工具后单独签署该一次性安装工具。安装工具签名包含用途标识及带版本的文件名，防止在其他版本名称下复用。发布器只需要固定公钥及由调用方持有的发布锁。它验证输入，拒绝版本回退或修改不可变版本，并在切换当前目录指针前发布完整文件。私有签名材料留在分发服务器之外。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DSH profile](../../packages/boot/app-boot/README.zh.md)：profile 组合与加载。
- [用户批准](../../packages/interaction/user-approval/README.zh.md)：agent 操作的一次性决定。
- [服务器更新发布](../../apps/desktop-tauri/server-updates/README.zh.md)：分发与运维恢复。
- [已安装 DSH 更新决策](../../.agents/notes/implemented/architecture/2026-09-15-installed-dsh-component-updates.zh.md)：职责划分与未采用方案。
- [桌面发布](../../apps/desktop-tauri/README.zh.md#release)：原生安装与重启行为。

-----

<a id="model-experience"></a>
## 模型体验

`clawmaster_updates` 检查更新元数据，不需要写入批准。`clawmaster_update` 选择组件、运行时或原生版本；它的参数不能提供任意 URL、信任密钥、本地路径或 profile 配置行。变更需要归属 agent 会话，并取得 `allowed-once` 决定；拒绝或取消不构成写入授权。结果区分等待 Loader 激活、已暂存的须重启变更、需要桌面支持的运行时文件及需要原生安装的文件。模型必须准确报告这些状态，不能把已暂存或已下载的更新描述为已生效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办事项

可用操作取决于目录及所选 Host。

- 初始组件目录仅包含 `updates` 版本 `0.1.0`；它不代表存在新 DSH 运行时或其他组件。
- 不提供独立更新页面或侧栏。用户通过现有命令和 agent 工具进入。
- 须重启变更仅暂存。此包不包含重启时自动应用或 Host 停止后的替换命令。
- DSH 核心及原生应用文件不能热替换。经过验证的原生下载仍需桌面安装流程。
- 激活和回滚回执描述 profile 编辑。Loader 健康状态及真实已安装桌面的兼容性须另行观测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
