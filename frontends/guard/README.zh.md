---
description: "在工具调用执行前做确定性审查：拦截不可逆命令，并把一切破坏性操作交给用户本人批准。"
kind: "package-reference"
---

# @clawmaster/dsh-guard

[English](README.md) | 中文

## 摘要

ClawMaster Guard 是 ClawMaster 围绕智能体工作所做的审查层，覆盖三个「审查还能改变结果」的时刻：

- **过程**（`tools/pre-execute`，与 Claude Code、Codex 两个 hook 桥接器相同的拦截点）：拒绝那些会毁掉用户没有要求毁掉的东西的调用。
- **结果**（`session/event`，每个 `turn/end`）：把刚结束的这一回合还原成可核对的事实，并归档进笔记库。
- **方案**（`exit_plan_mode`）：预留，是下一阶段。

它**绝不会**代替模型批准破坏性操作。致命模式（根目录、家目录或通配符删除，设备/文件系统写入，fork 炸弹，删除 `.git`，先改写 `HOME` 再借它删除）直接拒绝；其余破坏性操作一律升级为审批请求，而**在没有任何应答者的会话里，审批请求会按失败关闭处理**：当审批策略为 `never` 时，该操作会被阻断而不是放行——这正是它在无人值守时仍然有效的原因。

## 判定表

| 风险 | 例子 | 决定 |
| --- | --- | --- |
| `critical` | `rm -rf /`、`rm -rf ~`、`rm -rf *`、`rm -rf .`、`rm -rf .git`、`HOME=/tmp rm -rf ~/x`、`find / -delete`、`mkfs.* /dev/…`、`dd of=/dev/…`、`chmod -R 777 /`、fork 炸弹 | 拒绝 |
| `high` | 其它 `rm`/`unlink`/`shred`、`git reset --hard`、`git clean -fdx`、`git push --force`、`git branch -D`、`npm publish`、`docker system prune`、`kubectl delete`、`terraform destroy`、`rsync --delete`、`DROP TABLE`、无 `WHERE` 的 `DELETE FROM`、`kill -9`、`truncate -s 0`、覆盖家目录顶层文件的重定向 | 请求审批 |
| `medium` | 其它会替换文件内容的重定向 | 放行并记录 |
| `low` | 读取、构建、测试、`git status`/`commit`、新建文件 | 放行 |

规则按「读命令行的方式」运行：引号里的文字不会被当成命令，`sudo`、`env …` 之类的包装器会被剥掉（因此 `sudo rm -rf /` 按 `rm` 审查），子 shell 与 `&&` 链会被拆成独立命令，目标会先展开（`~`、`$HOME`、同一行内的赋值）再判定。

## 使用

在 profile 里挂载即可，无需其它配置：

```yaml
- name: '@clawmaster/dsh-guard'
```

可选配置：

```yaml
- name: '@clawmaster/dsh-guard'
  config:
    mode: observe
    shellTools: [bash, shell, run_command, exec]
    denyPaths: ['/Users/me/Documents']
    allowPaths: ['/tmp/scratch']
    resultReview: archive
    resultProject: ClawMaster
```

`mode: observe` 是在真正信任规则集之前用真实工作负载衡量它的方式：guard 会记录判定并继续委派。

## 结果审查

配置 `resultReview: archive` 后，guard 订阅会话事件流，并在每个 `turn/end` 依据**该回合自身的事件**合成审查：跑了哪些工具、它们指涉了哪些文件与命令、是否有结果报告失败、是否出现了测试/构建/lint。它会把无法确立的部分直接说明，而不是暗示成功（「本回合没有出现测试、构建或 lint，因此结论仅基于人工检查」）。

审查通过笔记插件发布的库访问句柄（`ctx.provide('clawmasterNotes')`）追加，因此当日笔记只有一个写入者、一条修订链——与智能体自己的 `notes_digest` 相同。没有跑工具的回合不归档，这正是让归档值得一读的原因。笔记插件未挂载时 guard 会说明并跳过；写入失败时会话继续，失败被记录。

## 模型体验

拒绝或审批请求会以 reason 字符串抵达模型：规则代码、规则为何触发、解析后的目标，以及 guard 期望的做法（「破坏性操作需要用户本人批准；guard 不会代替模型批准」）。模型应当报告阻断并向用户请示，而不是绕过去——这与 Codex 自动审查器给出的指令一致。

## 已知限制与后续工作

- 分类器是确定性的规则系统。它不判断「用户是否授权了某个具体目标」；一切破坏性操作都会被升级，因此用户明确要求的 `rm`（除非位于 `allowPaths` 下）同样需要一次确认。
- 命令行是被读取的，不是被求值的：通过变量、`eval`、脚本文件或解释器（`python -c "shutil.rmtree(…)"`）在运行时拼出的命令不会被解析成真实目标。`denyPaths` 与规则集是兜底，而不是沙箱。
- 尚无文件探查步骤：Codex 的审查器会先 stat 目标，再判定「范围很窄的删除」是否安全。增加只读目标探查是下一步，不在本版本内。
- 非 shell 工具不被审查。通过自身 API 删除的工具（例如笔记库自己的删除）保留其自带的审批闸门。

## 验证

`npm --prefix frontends/guard test` 先构建再运行测试套件：73 条用例覆盖上表的风险判定、目标展开、`sudo`/`env` 前缀、子 shell 与命令链、引号内文字不得误报、决定映射、`observe` 模式、`allowPaths`/`denyPaths`、workdir 解析，以及挂载本身——包括「拒绝不会抵达管线」和「审查抛错时改为委派而不是弄坏智能体」。结果审查另有专属用例：从代表性事件还原事实、无法识别的载荷、命令只取首行、合成出的审查文本、按会话缓冲、`off` 默认值、笔记库缺失，以及写入失败。
