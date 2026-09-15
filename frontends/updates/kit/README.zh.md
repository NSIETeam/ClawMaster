---
description: "使用 ClawMaster 更新接入 ZIP 检查现有桌面，批准首次安装更新器，并识别何时需要原生升级。"
---

# ClawMaster 更新接入包

[English](README.md) | 中文

## 概述

这份 ZIP 为兼容的 ClawMaster 桌面接入更新通道。它包含只读检查工具，以及可在本地安装的已签名更新组件。ClawMaster 会先检查实际运行时，展示拟执行的修改，再由你确认该计划后安装。完整桌面和 DSH 核心升级走原生安装流程。

## 目录

- [使用接入包](#use-the-kit)
- [理解检查结果](#understand-the-result)
- [兼容范围](#compatibility)
- [数据与恢复](#data-and-recovery)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

<a id="use-the-kit"></a>
## 使用接入包

执行包内内容前，先将 ZIP 的 SHA-256 摘要与[官方下载索引](https://8.140.52.117/updates/clawmaster/kits/0.1.0/delivery.json)核对。启动已有的 ClawMaster 桌面，将 ZIP 解压到独立文件夹。把[执行说明](guide/README.zh.md)及解压文件夹的位置交给 ClawMaster，请它先检查本机安装并展示计划。保留文件之间的相对位置，让工具能够找到已签名的目录、组件归档及必需的校验文件。

入口文件为 `update-kit.mjs`，默认操作是只读 `inspect`，要求 Node `^22.19 || >=24`。ClawMaster 通过启动记录定位已安装的 Node 可执行文件，再运行工具。查看所选 DSH 主目录、运行时位置、组件版本及拟修改的 profile。确认该计划后，ClawMaster 才使用计划中的产物摘要和 profile 修订号，备份相关 profile 文件并首次挂载更新器。如果这些信息在安装前改变，应重新检查并查看新计划。

ZIP 中的已签名文件支持离线首次安装。后续服务器检查及原生更新下载需要联网。后续检查出现网络错误，不代表本地组件安装失败。

挂载后，请 ClawMaster 在同一个 Host 中执行 `/updates`。该命令列出当前运行时信息及可用更新元数据。在该 Host 中看到更新器命令和工具，才能确认 Loader 已加载插件；仅有 `activation-pending` 安装回执不能证明这一点。

<a id="understand-the-result"></a>
## 理解检查结果

接入包根据接收机器上的实际证据选择处理方式。

| 结果 | 下一步 |
|---|---|
| `supported-component-bootstrap` | 查看首次安装计划，然后明确确认这一份计划。 |
| `updater-already-present` | 使用现有更新入口；接入包不替换它。 |
| `needs-location` | 提供实际安装或运行时位置，再次检查。 |
| `native-upgrade-required` | 保存工作后，使用原生桌面升级流程。 |
| `activation-pending` | 观测 Loader 和 `/updates` 后再报告成功。 |

需要原生升级时，`native` 先联网查询计划。另行确认后的调用要求已存在的 DSH 主目录，并将已验证产物下载为具有正确安装文件后缀的文件。macOS 得到 `.app.tar.gz` 应用归档，需要另行完成原生安装。接入包会报告这一步仍未完成，不会为了完成更新而卸载当前桌面、删除数据或重启当前对话。

<a id="compatibility"></a>
## 兼容范围

源码对比覆盖八个已发布标签：`desktop-v0.2.0-beta.1` 至 `desktop-v0.2.0-beta.6`、`desktop-v0.2.0-release` 及 `desktop-v0.2.1`。它们的 DSH 核心及命令、工具、批准包均使用 `0.1.5-rc.2`，启动记录也提供共同的位置查找机制。这是源码层面的兼容依据，不代表每个版本、每个操作系统的安装包都已实测。

接入包检查接收方的实际运行时及 Cordis 包，不仅凭版本标签或记忆中的路径判断。未知的更早版本、缺失的运行时或不兼容安装会返回位置补充或原生升级结果。接入包不会向未经确认的运行时强行挂载插件。

接入包版本 `0.1.0` 标识此接入工具及已签名内容，不是原生桌面版本号。临时环境验收和源码兼容检查不能证明 Windows 安装器已在 Windows 沙箱中实测。

<a id="data-and-recovery"></a>
## 数据与恢复

检查读取运行时身份及制定安装计划所需的 profile 信息，不读取独立凭据文件，也不收集业务文档和笔记。备份覆盖所选 DSH 主目录下的 `profiles/web/cordis.patch.yml`、`profiles/web/package.json` 及 `cordis.patch.yml`。它记录文件缺失情况，将已有内容存于 `DSH_HOME/clawmaster-updates/kit-backups/` 下，创建目录时使用 `0700`、文件使用 `0600`。profile 内容可能包含直接写入配置的凭据，备份须保留在本地并保持私有。

保留返回的安装和备份回执。接入包没有恢复命令。若安装或 profile 加载失败，须保留备份，另行恢复前查看当前 profile，避免覆盖后续编辑。已有更新器不会被替换。更新器自身的更新仅暂存，单纯重启不会应用它。

<a id="further-exploration"></a>
## 进一步探索

- [给 ClawMaster 的执行说明](guide/README.zh.md)：按顺序完成检查、批准及验证。
- [ClawMaster 桌面发布](https://github.com/NSIETeam/ClawMaster-Desktop/releases)：原生安装包及版本说明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

准备好模块构建依赖后，在 `frontends/updates` 中执行接入包构建。打包器保留已发布更新器 `0.1.0` 归档及签名目录的原始字节。将产物目录、签名密钥路径及被 Git 忽略的输出目录设为绝对路径；源码提交使用 40 位小写十六进制字符。签名私钥只留在签名机器上。

```sh
node scripts/build-kit.mjs
node scripts/build-kit.mjs --check
node scripts/pack-kit.mjs --published-payload-dir "$KIT_PUBLISHED_PAYLOAD_DIR" --signing-key "$KIT_SIGNING_KEY_PATH" --source-commit "$KIT_SOURCE_COMMIT" --output-dir "$KIT_OUTPUT_DIR"
```

输出包括 ZIP、`SHA256SUMS.txt`，以及带独立 Ed25519 签名 `delivery.json.sig` 的 `delivery.json`。已签名交付字段绑定接入包版本、源码提交、文件名、带版本的下载地址、SHA-256 及字节数。执行解压后的代码前，须使用[独立固定的公钥](https://github.com/NSIETeam/ClawMaster-Desktop/blob/b9b14f1ef05bbc9914658a1a672d820f793e92f8/frontends/updates/component-signing.pub)验证索引并核对 ZIP 字节；包内已签名清单随后覆盖每个打包文件。

只将发布文件复制到服务器私有收件目录。在发布服务器上使用绝对路径，并在整个命令执行期间持有发布锁。发布器验证已签名交付索引及 ZIP 后，才以原子操作公开完整且不可变的版本目录；它只需要公钥。

```sh
flock "$KIT_PUBLICATION_LOCK" node "$KIT_PUBLISHER_PATH" --inbox "$KIT_PRIVATE_INBOX" --root /var/lib/clawmaster-updates/kits --public-key "$KIT_PUBLIC_KEY_PATH"
```

`KIT_PUBLISHER_PATH` 指向服务器上的 `frontends/updates/scripts/publish-kit.mjs`。下载路由 `/updates/clawmaster/kits/` 以仅允许 GET 的不可变响应提供发布目录。发布后的 `0.1.0` 目录在同一个带版本的地址前缀下提供 `clawmaster-update-kit-0.1.0.zip`、`delivery.json`、`delivery.json.sig` 及 `SHA256SUMS.txt`。

</details>
