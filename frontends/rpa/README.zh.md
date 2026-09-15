---
description: "增加受治理的桌面自动化，以及每次单独授权的已选微信聊天读取。"
kind: "package-bundle"
---

# @clawmaster/dsh-rpa

[English](README.md) | 中文

## 概要

通过 ClawMaster 原生组件运行运维定义的自动化并检查桌面控件。只有本次读取得到批准后，才能读取已选微信聊天。聊天文字进入当前 AI 会话、会话记录及所配置的模型；读取器不会发送消息或持续监听聊天。

## 目录

- [使用本包](#use-this-package)
- [读取已选微信聊天](#selected-wechat-reading)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [验证](#verification)

<a id="use-this-package"></a>

## 使用本包

桌面 profile 通过[桌面默认配置](../../apps/desktop-tauri/scripts/desktop-defaults.mjs)声明这个内置层。[补丁](cordis.patch.yml)挂载 Host 插件；挂载只注册工具，不启动原生助手或检查桌面。需要原生操作但组件缺失时，会返回安装诊断。

| 工具 | 范围 |
| --- | --- |
| `rpa_run` | 运行运维安装的工作流；此运行器接受无副作用检查点，并拒绝外部副作用。 |
| `rpa_native` | 读取原生能力、工具定义或有界的通用桌面快照。 |
| `rpa_call` | 调用原生 RPA 目录；桌面操作需要一次性用户授权。 |
| `wechat_read` | 一次性授权后读取名称完全匹配、已由用户选定的微信聊天文字。 |

<a id="selected-wechat-reading"></a>

## 读取已选微信聊天

先在微信里手动打开目标聊天，再使用完整显示标题和 1 到 50 的 `limit` 请求 `wechat_read`。群标题须包含界面显示的人数后缀。每次调用都会再次确认聊天、条数和发送给所配置模型的用途。拒绝、取消、缺少审批服务或参数变化都会阻止原生探测。

macOS 读取器识别 `com.tencent.xinWeChat`，要求其主窗口，并只接受唯一的 `big_title_line_h_view` 标题与 `Messages` 或 `消息` 列表。先获取元素引用和位置，在可见行中选出上限以内的引用，之后才查询对应文字。返回前再次核对标题。布局未知、标题不符或窗口位置变化时会拒绝，不返回消息正文或其它聊天名称。

工具不会打开聊天、翻页、读取数据库、解密历史、截图、发送消息或启动监听。它跳过侧栏列表和编辑控件，不返回联系人列表或聊天预览，也不保存原生快照。返回的字符串是辅助功能文字条目，不推断发送人和时间。长条目最多保留 4,000 个字符，结果会标明截断。

<a id="understand-the-implementation"></a>

## 理解实现

<details>
<summary>实现细节</summary>

[Host 读取器](src/wechat.ts)负责 DSH 一次性授权和结果校验。[原生读取器](native/src/wechat.rs)落实标题、布局、可见性和数量检查；macOS 适配器惰性查询 AX 属性，不预先抓取整个控件树的文字。原生子进程只继承白名单内的系统环境变量，输出和运行时间有上限；取消后等待所拥有进程退出才结束调用。

助手优先从 `dist/native/<platform>-<arch>/clawmaster-rpa-native[.exe]` 解析，开发时可回退到本地 Cargo release/debug 路径。通用 RPA 保留按产物限定的引用及加密状态。这些读取限制由 `wechat_read` 提供，不会沙箱化任意本机命令，也不替代其它工具的授权策略。

</details>

<a id="model-experience"></a>

## 模型体验

等待中的卡片标明已选聊天读取及所需授权；完成卡片展示结果或拒绝原因。返回的消息带有明确的不可信数据提示，其中看似指令的文字也只是引用的聊天数据。DSH 记录的工具结果与发送给所配置模型的内容一致。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓工作

微信读取器包含 macOS AX 适配器及合成范围测试。与每个微信版本的实际兼容性需要另行授权的有限测试聊天验证；能够编译不等于真实聊天验收。Windows 与 Linux 返回明确的不支持响应，不探测桌面。macOS 需要辅助功能授权；此纯文字读取器不申请屏幕录制权限。现有通用 RPA 工具仍有更广的操作范围。

<a id="verification"></a>

## 验证

在本包目录运行 `node scripts/build.mjs --check` 校验 Host 产物，运行 `node --import tsx/esm --test tests/*.test.mjs` 验证产物入口。原生范围测试使用带文字访问计数的合成树；普通测试不会读取真实桌面或个人聊天。发布验证设置 `CLAWMASTER_REQUIRE_NATIVE=1`，缺少助手时直接失败，不会静默跳过能力及拒绝检查。

### 开发备注

通用 RPA 的职责及尚待安装后验收的平台行为，见 [RPA 恢复决策](../../.agents/notes/implemented/feature/2026-09-14-clawmaster-rpa-recovery.zh.md)。
