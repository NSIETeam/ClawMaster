---
description: "将 DSH 模型密钥与插件授权保存在操作系统凭据库中的桌面配置层。"
kind: "package-bundle"
---

# ClawMaster 安全凭据

[English](README.md) | 中文

## 概述

ClawMaster 桌面配置通过 macOS 钥匙串或 Windows 凭据管理器解析模型密钥与插件授权。桌面宿主负责原生存储；DSH 配置只保存凭据引用。这个私有 bundle 会替换基础配置中的文件凭据提供方，只包含在 ClawMaster 桌面版中，不支持单独作为 bundle 使用。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型侧体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

ClawMaster 会在桌面 Web 配置中安装此 bundle。用户通过产品的模型设置管理密钥；运行时通过 Tauri 私有宿主管道调用平台凭据 API。WSL 模式使用 Windows 桌面宿主的安全存储；独立 Linux 桌面宿主暂不支持。

首次启动时，提供方会导入 `$DSH_HOME/.credentials.yaml`、继承的秘密环境变量，以及启动目录和用户目录中的 `.env` 文件里可识别的条目。WSL 启动也会传入已解析的 Windows DSH 主目录作为明确迁移来源，使升级到 WSL 的用户可以通过同一宿主 broker 导入 Windows 旧凭据，而无需将凭据文件复制到 Linux 主目录。删除对应明文条目前，提供方会先回读每个值，并逐字节保留无关的 `.env` 内容。原生存储操作失败、文件格式错误、来源不受支持或已有值冲突时，源数据会保留并记录警告，应用仍会继续启动。用户可在模型设置中保存密钥后，手动删除仍保留的旧来源。

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>展开查看实现细节</summary>

[配置补丁](cordis.patch.yml)会替换 `credentials` 服务行，因此现有 DSH 消费者和实际模型提供方仍使用公开的 `ctx.credentials` API。密钥值通过继承的 Tauri 管道，按专用逐行协议传输；只有 Rust 桌面宿主会调用系统钥匙串或凭据管理器。由于原生存储不支持枚举记录，提供方会在 `$DSH_HOME` 下维护一份仅含元数据的记录索引。

迁移会拒绝链接文件与非普通文件，使用系统原生的原子不覆盖写入，并会在清理源文件前验证每个引用和记录。插件初始化会捕获迁移错误；之后需要凭据的操作会在对应功能处报告安全存储不可用。

</details>

<a id="further-exploration"></a>
## 延伸阅读

[桌面宿主](../../apps/desktop-tauri/src-tauri/src/native_broker.rs)负责操作系统 API。[凭据提供方 API](../../packages/credentials/credentials/README.zh.md)定义了 DSH 消费者使用的引用与记录操作。

<a id="model-experience"></a>
## 模型侧体验

模型适配器会在每次操作即将使用密钥时，通过 `ctx.credentials` 解析配置的凭据引用。通过产品设置保存的密钥会在每次操作时从系统安全存储读取；密钥值不会进入配置、记录索引或提供方日志。

## 已知限制与后续工作

- 系统原生凭据操作依赖 ClawMaster 桌面宿主及其继承管道 broker。独立 DSH 进程无法访问此提供方。
- 在本包支持安全存储 broker 之前，Linux 与其他桌面外壳不可用。
- `.env` 清理失败时，源文件会保留并提示需要手动清理；用户应确认模型设置中已显示迁移的密钥，再删除对应条目。

<a id="dev-note"></a>
### 开发者说明

<details>
<summary>维护者工作背景</summary>

macOS 钥匙串和 Windows 凭据管理器的原生行为，必须分别在对应操作系统上的已构建桌面宿主中验证。流协议测试不能代替操作系统 API 或打包应用验收。

</details>
