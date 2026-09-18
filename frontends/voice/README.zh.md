---
description: "ClawMaster 内置语音组件：离线 Whisper 听写 + 说话人分离，产物直接喂给内置笔记库。"
kind: "package-bundle"
---

# ClawMaster Voice（语音）

[English](README.md) | 中文

## 摘要

这个桌面内置包让你在侧栏里录一场会议，用 Whisper 离线转写、按说话人分开，并留下一条可供内置笔记库推导的时间轴。它不需要云服务、不需要 API Key、不需要装任何第三方软件。音频不落盘：落盘的只有每句识别结果那一行文字。

## 目录

- [使用方式](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用方式

在侧栏打开「语音」标签，给会议起个名字，按「开始录音」。第一次按下时 macOS 会询问麦克风权限。面板会显示电平、已经分开的说话人，以及每一句识别结果的时间码与说话人。

知道是谁之后就尽快改名：改一个说话人的名字，**已经记录的句子会一起跟随**——因为笔记是从时间轴推导出来的，而不是就地改写正文。如果聚类把一个人拆成了两个，用箭头按钮把其中一个并过去。「记住这个声音」会把声纹存到某个名字下，之后的会议不用再告诉它就认得出来。

按「停止录音」释放麦克风并给最后一句收尾。转写内容会留在面板里，也留在时间轴文件里。

接下来让 agent 把这场会写成笔记（或由它自行判断）。`voice_writeup` 工具会从**录音自己的时间轴**生成 `录音/<日期> <标题>.md`——每一句都带说话人与时间码——并在当日日记追加一行链接到它，于是这场会在它发生的那一天就能被找到。因为笔记是推导出来的，改完说话人名字再生成一次就是"纠正"而不是"改写"；你在笔记里 `<!-- clawmaster-voice:body -->` 标记下方写的段落，每次重生成都会被保留。这一步写的是笔记库，因此需要一次性审批。

每场会议会在 `<笔记库>/.clawmaster/voice/<sessionId>.jsonl` 留下一份只追加的时间轴。在正式写笔记之前，笔记库里的其他内容不会有任何改动。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节与贡献者检查——点开展开</summary>

面板负责麦克风与断句，Host 负责识别、归属与落盘。这样分工的原因是：只有客户端能碰到设备，而只有 Host 能把模型只加载一次而不是每句一次。

编解码与端点检测是不依赖任何东西的纯函数（`wav.ts`、`endpointer.ts`），所以两侧共用、两侧都能在没有设备的情况下测试。断句用的是能量法加校准过的噪声地板，而不是神经网络 VAD：零成本、不阻塞音频线程，而且它的两个参数正好是用户在嘈杂房间里能判断的那两个。

说话人归属是「逐句声纹 + 余弦距离在线聚类」，外加一本跨会议存活的声纹簿。名字**只**来自人的决定——一次改名，或一次与已登记声纹的匹配——所以错的归属会一直可见、可纠正，而不是悄悄变得"看起来合理"。

引擎是 `sherpa-onnx-node`（Apache-2.0），一个带 macOS arm64 预编译二进制的可选原生依赖。模型不随包分发：它们体积大，因此放在 `~/.clawmaster/components/voice/models`，缺失时组件会明确报出缺了哪些文件。`scripts/fetch-models.mjs` 从实测可用的镜像下载，并且**每下载一个文件都校验大小与 sha256**——因为其中一个镜像会把大文件截断却照旧返回 HTTP 200。

支持两个环境变量：

| 变量 | 作用 |
|---|---|
| `CLAWMASTER_VOICE_MODELS` | 模型放在家目录以外时，指向实际位置。 |
| `CLAWMASTER_VOICE_ENGINE` | 指向一个导出 `createEngine(options)` 的模块，整体替换引擎（Host 测试也正靠它在没有模型时运行）。 |

写笔记走的是笔记插件公开的 access 句柄（`ctx.get('clawmasterNotes')`）而不是直接碰文件系统，所以笔记库始终只有一个写入者、一条修订链；笔记组件没加载时，工具会直接说明，而不是先写点什么。

```sh
npm install --include=dev --prefix frontends/voice
node frontends/voice/scripts/build.mjs
node frontends/voice/scripts/build.mjs --check
npm test --prefix frontends/voice
```

两侧都用 esbuild 打包：宿主半边是 Node ESM、工作区包保持 external；客户端半边是 CommonJS，包在 `window.__ModuleLoader__.load` 里，与其他产品前端完全一致。`--check` 在产物与源码不一致时失败；测试套件里还包含一遍对所有 `.mjs` 的 `node --check`，因为 TypeScript 加载器会把测试文件里的纯语法错误掩盖掉。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- `src/host.ts` —— 五条鉴权路由与两个 agent 工具，以及卸载清理。
- `src/store.ts` —— 只追加的时间轴，以及改名与合并如何被重放。
- `src/endpointer.ts` —— 一句话从哪里开始、到哪里结束，以及噪声地板的校准。
- `src/speakers.ts` —— 在线聚类与声纹簿。
- `tests/` —— 76 个用例，覆盖编解码、时间轴、聚类、服务与 Host。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 面板目前只收集会议标题这一项元数据；项目链接与正式笔记的落盘是下一阶段。
- 录制中途退出应用会丢掉「正在说的那一句」；已经写入时间轴的每一句都还在。
- 说话人分离需要每个人积累几句才稳定；声纹匹配用的是固定阈值，没有按房间调参。
- 麦克风采集走的是 `ScriptProcessorNode`（已被 AudioWorklet 取代）；等桌面端 WebKit 版本固定之后再迁移。
