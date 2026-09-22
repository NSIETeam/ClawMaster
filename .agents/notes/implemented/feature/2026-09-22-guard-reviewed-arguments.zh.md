# Agent Note：按工具实际存放的位置审查它的命令文本

Status: implemented

[English](2026-09-22-guard-reviewed-arguments.md) | 中文

## 问题

Guard 审查的是一份配置的工具名清单，并且对每个名字只读一个固定参数：`command`。由此产生两个缺口，而两者都不会出现在日志里。清单之外任何一个能跑 shell 的工具完全不被审查——调用以 `unreviewed-tool` 抵达管线，不带任何判定。而清单之内、命令文本放在别的参数名下的工具同样不被审查，因为参数名不属于配置的一部分：已安装的 harness 把 `terminal_send` 声明为 `text: { type: 'string', required: true }` 并默认提交 Enter，所以把那个名字加进清单也读不到任何东西。

## 决策

`shellTools` 的条目现在要么是裸工具名（通过它的 `command` 参数审查），要么是 `{name, argument}`，指明承载该工具命令文本的参数。`shellCommandOf` 从条目解析出参数名并只读那一个。分类器、判定映射与目标探查都不变。

默认清单变为 `['bash', 'shell', 'run_command', 'exec', { name: 'terminal_send', argument: 'text' }]`。如果某个条目既不是非空名字、也不是可用的 `{name, argument}` 对，那么整份配置清单都视为不可用，解析退回默认清单，而不是接受一份只读了一半的清单——否则一条读不懂的条目会静默缩小被审查的范围。

## 影响

终端输入按命令行审查，因为它本来就是命令行：`terminal_send` 提交的就是它写入的那些字节。审查只看到一次提交，看不到别的东西——看不到会话之前的输出，也看不到这段文本补全的是哪一行——因此未写完的一行或 REPL 的回答会按它本身的文本被判。普通输入仍是 `low`、直接放行；其余情形适用与 `bash` 相同的规则。

PowerShell 仍留在默认清单之外。分类器读的是 POSIX 命令行，而这里没有任何用例在 PowerShell 文本上度量过它；把 `pwsh` 放进来等于让每一个 Windows 部署被一套未度量的规则强制执行审查——误判成 `high` 会挂起调用，误判成 `critical` 会直接拒绝。在有人于该平台度量过分类器之前，`apps/desktop-tauri/execution-surfaces.json` 把这件事记录为一条未强制面，本笔记不关闭它。

清单之外任何能跑 shell 的工具仍然不被审查，而且这种缺失仍然静默。这份清单就是本插件覆盖范围的全部；产品里新增一个执行面，不会自动出现在这里。
