---
description: "在工具调用执行前做确定性审查：拦截不可逆命令，并把一切破坏性操作交给用户本人批准。"
kind: "package-reference"
---

# @clawmaster/dsh-guard

[English](README.md) | 中文

## 摘要

ClawMaster Guard 会在每个工具调用即将执行前审查它，并拒绝那些会毁掉用户没有要求毁掉的东西的调用。它挂在 harness 的 `tools/pre-execute` 瀑布事件上——与 Claude Code、Codex 两个 hook 桥接器相同的拦截点——因此对 shell 工具、子智能体，以及任何经过该管线的工具都生效。

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
```

`mode: observe` 是在真正信任规则集之前用真实工作负载衡量它的方式：guard 会记录判定并继续委派。

## 模型体验

拒绝或审批请求会以 reason 字符串抵达模型：规则代码、规则为何触发、解析后的目标，以及 guard 期望的做法（「破坏性操作需要用户本人批准；guard 不会代替模型批准」）。模型应当报告阻断并向用户请示，而不是绕过去——这与 Codex 自动审查器给出的指令一致。

## 已知限制与后续工作

- 分类器是确定性的规则系统。它不判断「用户是否授权了某个具体目标」；一切破坏性操作都会被升级，因此用户明确要求的 `rm`（除非位于 `allowPaths` 下）同样需要一次确认。
- 命令行是被读取的，不是被求值的：通过变量、`eval`、脚本文件或解释器（`python -c "shutil.rmtree(…)"`）在运行时拼出的命令不会被解析成真实目标。`denyPaths` 与规则集是兜底，而不是沙箱。
- 尚无文件探查步骤：Codex 的审查器会先 stat 目标，再判定「范围很窄的删除」是否安全。增加只读目标探查是下一步，不在本版本内。
- 非 shell 工具不被审查。通过自身 API 删除的工具（例如笔记库自己的删除）保留其自带的审批闸门。

## 验证

`npm --prefix frontends/guard test` 先构建再运行测试套件：62 条用例覆盖上表的风险判定、目标展开、`sudo`/`env` 前缀、子 shell 与命令链、引号内文字不得误报、决定映射、`observe` 模式、`allowPaths`/`denyPaths`、workdir 解析，以及挂载本身——包括「拒绝不会抵达管线」和「审查抛错时改为委派而不是弄坏智能体」。
