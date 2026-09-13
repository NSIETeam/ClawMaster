---
description: "面向 ClawMaster 桌面用户和维护者，通过现有 DSH 侧栏在本地编辑 Word、Excel 和 PowerPoint。"
kind: "package-bundle"
---

# ClawMaster Office

[English](README.md) | 中文

## 概要

此桌面组合包使用本地 ONLYOFFICE 编辑器和 WebAssembly 转换，在现有侧栏打开 `.docx`、`.xlsx` 和 `.pptx` 文件。文件读写复用侧栏现有的 Session 文件路由。编辑不调用模型，不需要外部文档服务器，也不上传云端。查看器保留 ONLYOFFICE 法律声明和源码入口。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

从当前任务的文件树打开 Office 文件。使用编辑器的保存按钮，等待查看器显示“已保存”后再关闭标签页、切换 Session 或退出应用。保存保留原文件名和 Office 格式。桌面安装包含此私有组合包，不提供独立 npm 发布安装。

文件打开后若被其他写入者修改，保存会提示冲突并保留磁盘文件。可从查看器下载当前草稿，或关闭后重新打开最新文件。网络或转换失败不会被确认成保存成功。草稿只保留在仍打开的查看器内，应用崩溃后无法恢复。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现与贡献者检查 — 点击展开</summary>

[配置层](cordis.patch.yml) 注册三个 Better Sidebar 文件查看器，并在现有 DSH WebServer 上注册静态路由。认证以及 Host/Origin 检查由 DSH connection 服务负责。Host 在注册路由前校验构建固定的清单及每个资源；资源变化、多余、缺失或含符号链接都会导致启动失败。`runtimeRoot` 可指定包含完全一致已校验资源的绝对目录。

iframe 只接受所属查看器打开的一份文档。查看器对打开的文件字节计算哈希，上传编辑后的文件时发送强 SHA-256 `If-Match` 请求头。[侧栏补丁](../../apps/desktop-tauri/patches/dsh-better-sidebar@0.19.1.office-save.patch) 串行提交上传，在接收完整请求体后检查当前版本，冲突时返回 HTTP 412。它检测并发变化，但不承诺对其他文件系统进程进行原子比较。

从仓库根目录运行以下命令。只有资源准备会下载固定的上游归档；`--archive /absolute/path/html.zip` 可使用已下载归档，并执行相同的强制哈希校验。普通构建和 `--check` 不访问网络。独立 npm 锁从 registry 解析依赖；资源准备与构建会拒绝本地依赖链接。

```sh
npm ci --prefix frontends/office --ignore-scripts
node frontends/office/scripts/prepare-runtime.mjs
node frontends/office/scripts/build.mjs
node frontends/office/scripts/build.mjs --check
npm test --prefix frontends/office
```

每个编辑器 iframe 在 SDK 之前加载能力适配脚本：缺少 `requestIdleCallback` 的 WebKit 使用可取消的定时器延后启动工作，并报告没有可用空闲时间。已有原生调度保持不变。资源准备还为 Chromium 专有的内存采样添加能力检查，并修正演示文稿主题 URL，保留上游法律标记。这些[兼容转换](scripts/editor-compatibility.mjs)及其源码均包含在已校验资源中。

运行资源在安装包压缩前增加约 178 MiB。资源生成是确定性的，且不进入 Git。[上游溯源](vendor/onlyoffice-web-local/SOURCE.json) 固定发布归档、转换器源码和本地修改。[浏览器测试](tests/browser.test.mjs) 在隔离本地服务器中使用自造文件，覆盖有无原生空闲调度两种情况，需要 Playwright Chromium 及已应用补丁的侧栏包。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [桌面安装与组合](../../apps/desktop-tauri/README.zh.md)
- [许可与第三方源码](THIRD_PARTY_NOTICES.md)

-----

<a id="model-experience"></a>
## 模型体验

无。此组合包注册文件查看器和静态资源，不增加工具、提示词或模型可见的 Session 事件。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

输入和保存文件限制为 100 MiB，同时受现有侧栏上传上限约束。仅注册 `.docx`、`.xlsx` 和 `.pptx`。旧版二进制 Office 格式、宏、加密文件、协同编辑以及与 Microsoft Office 完全一致的排版不属于本次集成验收范围。固定上游界面以中文为主，字体仅包含一个子集；不可用字体使用编辑器替代字体。编辑复杂文档时请保留原件。

<a id="dev-note"></a>
### 开发说明

<details>
<summary>维护者工作说明 — 点击展开</summary>

本地转换运行时采用 AGPL-3.0-only 许可。分发桌面时应保留其法律声明、标志要求和对应源码入口；[许可证](LICENSE)与[第三方声明](THIRD_PARTY_NOTICES.md)说明来源及修改。

</details>
