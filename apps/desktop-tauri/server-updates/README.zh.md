---
description: "ClawMaster 更新服务器配置、签名版本同步、原子发布与恢复。"
---

# ClawMaster 更新服务器

[English](README.md) | 中文

## 概要

更新服务器通过 HTTPS 提供签名桌面更新文件。GitHub 仍是构建与发布来源。独立同步服务检查最新正式版本，验证文件后发布完整版本，不构建、签名或发布应用。[桌面 README](../README.zh.md#release)负责客户端更新确认与版本选择。

## 目录

- [端点与客户端](#endpoints-and-clients)
- [服务器配置](#server-configuration)
- [发布与失败](#publication-and-failures)
- [验证与恢复](#verification-and-recovery)
- [开发备注](#dev-note)

<a id="endpoints-and-clients"></a>
## 端点与客户端

主要 manifest 为 `https://8.140.52.117/updates/clawmaster/v2/latest.json`。产物 URL 使用 `https://8.140.52.117/updates/clawmaster/v2/versions/<version>/<original-filename>`。原生配置保留公开 GitHub Latest manifest 作为备用地址。主要端点响应成功时，不会再与备用地址比较；运维人员须独立监控同步是否及时，不能仅检查 HTTPS 是否可用。

已安装的 `0.2.1` 程序使用编译时的 GitHub 端点。服务器不会修改这些程序或其 DSH 配置。后续原生版本可以交付所配置的服务器端点；镜像已有版本不会发布这样的更新，也不会重写 GitHub 发布附件。

当前发布要求四个更新目标：Windows x64 NSIS、macOS arm64 应用压缩包、Linux x64 AppImage，以及 Linux x64 DEB。旧 manifest 可以额外包含 Intel macOS；拒绝任何其他缺失或未知目标。镜像不提供 DMG 文件或 Android 安装包的下载目录。

旧 `/updates/clawmaster/latest.json` 和 `/updates/clawmaster/versions/` 保留五目标的 0.2.1 通道及其不可变文件。更新组件 0.1.0 和 0.1.1 要求完整的旧目标集合；修改服务器响应不会更新其解析器。v2 服务写入独立状态目录。组件目录、组件产物与便携更新包保留现有根 URL。

<a id="server-configuration"></a>
## 服务器配置

[服务](clawmaster-updates.service)以专用 `clawmaster-updates` 用户运行[同步器](../scripts/sync-updater-channel.mjs)。v2 配置从 `/opt/clawmaster-updates-v2` 读取脚本，保留 `/opt/clawmaster-updates/release-signing.pub` 中的固定公钥，并将状态写入 `/var/lib/clawmaster-updates-v2`。旧 `/var/lib/clawmaster-updates` 目录树不属于此服务的可写状态。服务器需要 Node.js、minisign、aria2、systemd、flock，以及访问 GitHub 发布元数据和产物的出站 HTTPS 连接。不需要签名私钥。

| 同步器选项 | 含义 |
| --- | --- |
| `--state-dir` | 状态目录的绝对路径；仅公开其中的 `public` 子目录。 |
| `--public-key` | 固定 Tauri 发布公钥的绝对路径。 |
| `--base-url` | HTTPS 通道前缀，不包含 `/latest.json` 或 `/versions/<version>`。 |
| `--repository` | GitHub 来源仓库，默认为 `NSIETeam/ClawMaster-Desktop`。 |
| `--minisign` | 签名校验器可执行文件，默认为 `minisign`。 |
| `--aria2` | 更新产物的可选分段下载器；服务配置使用 `/usr/bin/aria2c`。 |

[manifest 生成器](../scripts/generate-updater-manifest.mjs)要求显式选择四目标发布的 `--target-set current`，或包含全部五个历史目标的 `--target-set legacy`。文件缺失不会自动选用更小的集合。它还接受 `--asset-base-url`，指定完整 HTTPS 版本目录，例如 `https://8.140.52.117/updates/clawmaster/v2/versions/0.2.2/`。它不同于同步器的通道级 `--base-url`。省略生成器选项时保留 GitHub 下载 URL；提供该选项时保留文件名与签名，只替换 URL 前缀。含凭据、查询参数、片段或不明确路径段的地址均被拒绝。

[定时器](clawmaster-updates.timer)每小时检查一次，随机延迟最多五分钟，并在停机后补执行。服务先取得非阻塞 flock，再执行同步；所有手动调用须使用同一把锁。服务限制执行时间为 45 分钟，内存为 512 MiB，单文件为 2 GiB，禁止提权，使用私有临时目录，对受管理状态以外的系统路径保持只读访问，并禁止访问主目录。

分段下载器保留 TLS 校验，禁用用户配置和 netrc 加载，使用系统解析器。进程超时后先终止并等待子进程退出，再清理暂存目录。每个完整文件必须匹配发布的大小、校验和及签名。

[Nginx 配置](clawmaster-updates.nginx.conf)仅在已有 HTTPS 虚拟主机内挂载更新前缀。正式 manifest 不缓存，版本文件使用一年不可变缓存。拒绝目录列表和声明路径以外的更新请求。独立的[已安装客户端插件](../../../frontends/updates/README.zh.md)使用 `/components/catalog.json` 及其分离的 `.sig`、不可变 `/components/artifacts/` 文件和版本化 `/components/installers/` 工具。组件目录在部署前签名；服务器仅持有公钥。原生同步不写入这些组件路径。TLS 证书签发与续期仍由现有虚拟主机负责；客户端保留证书验证。

<a id="publication-and-failures"></a>
## 发布与失败

同步器接受 GitHub 已发布的正式版本，拒绝预发行版本与版本回退。它下载来源元数据，按照发布的 SHA-256 清单检查所选文件，再使用固定公钥校验完整声明目标集合中的每个更新签名。发布附件中的公钥不能替换本地信任锚。产物文件名、签名和载荷字节保持不变；仅 manifest 下载 URL 指向镜像。

下载与验证在公开目录外进行。完整版本目录先移入公开树，再原子替换 `latest.json`。已有版本文件不可变。相同版本在重新验证后不作更改；发布中断时留下的完整版本可以直接启用，无须重新下载。来源 manifest、校验和及选定 GitHub 元数据保存在私有 `evidence/<version>` 目录下。

下载、校验和、签名或发布失败时，保留上次发布的 manifest。GitHub 发布元数据请求限时 30 秒，每个文件下载限时十分钟。脚本只执行一次同步，后续尝试由定时器负责。服务器无法连接 GitHub 时，仍可提供已发布文件，但无法发现新版本。

<a id="verification-and-recovery"></a>
## 验证与恢复

服务成功代表文件已同步，不代表所有平台均已成功安装。运维人员检查定时器与服务状态，核对 HTTPS manifest 的版本和缓存头，并按发布字节与签名验证每个声明的更新 URL。原生首次启动、更新确认、安装与重启仍由平台验收负责。

v2 迁移修改服务代码、状态路径和 Nginx 别名，不重写旧 manifest 或版本文件。使用管理员权限执行以下步骤：

1. 停止 `clawmaster-updates.timer`，停止正在执行的服务调用，并确认发布锁已释放。将现有单元、启用的 Nginx include 与服务脚本备份到管理员拥有的目录，记录旧 manifest、公钥和不可变文件的哈希。
2. 将同步器、生成器和验签器安装到 `/opt/clawmaster-updates-v2/scripts`，代码归 root 所有且服务不可写。保留现有公钥，安装 v2 服务配置并重新加载 systemd。不要将旧状态复制或移动到新目录。
3. 将提供的 Nginx location 合并到现有虚拟主机，保留无关路由与全部旧通道、组件及更新包别名。重新加载 Nginx 前先运行 `nginx -t`。
4. 执行一次 v2 服务同步，按照当前 GitHub 发布核对其回执、来源签名与 HTTPS 响应。逐一比较保留的旧文件哈希与迁移前的值，之后启用每小时定时器。旧五目标 GitHub Latest 仍可作为 v2 的有效初始化来源。

迁移失败时，停止 v2 服务与定时器，恢复备份的单元与 Nginx 配置，验证 Nginx 后再重新加载。保留已发布的 v2 文件以便恢复，旧通道保持不变。在恢复的代码能接受所选发布之前，保持同步停止。将正式指针指向旧版本不等于应用自动降级：服务器与客户端都会拒绝较低版本。修正后的发布使用新的正式版本。不可覆盖不可变文件、关闭 TLS 验证，或通过更换签名公钥让被拒版本通过。

[发布决策](../../../.agents/notes/implemented/architecture/2026-09-15-desktop-self-hosted-update-channel.zh.md)记录信任职责。[版本化通道决策](../../../.agents/notes/implemented/architecture/2026-09-15-versioned-native-update-targets.zh.md)说明旧解析器兼容性与保留路径。

<a id="dev-note"></a>
## 开发备注

无。
