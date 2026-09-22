# Agent Note：桌面脚本入口判定解析真实路径

Status: implemented

[English](2026-09-22-desktop-entry-guard-symlink.md) | 中文

## Problem

`apps/desktop-tauri/scripts/` 下的每个桌面脚本都通过比较 `import.meta.url` 与 `process.argv[1]` 判断自己是否为进程入口。`argv[1]` 是调用者敲下的路径，而 Node 报告的是已加载 ES 模块解析后的真实路径。19 个脚本只在用 `resolve()` 绝对化参数后就进行比较，另有 5 个直接比较原始参数，因此任何路径经过符号链接的调用都会让比较为假。守卫于是跳过入口点，进程以 0 退出，什么都没做，也没有任何输出。

文档化的验收采集命令是最大的受害者。`apps/desktop-tauri/acceptance/README.md` 让操作者用 `release-acceptance.mjs --template` 生成清单模板，而在 macOS 上保留证据最自然的工作目录是 `/tmp` 与 `$TMPDIR`，它们是指向 `/private/tmp` 与 `/private/var/folders` 的符号链接。`node /tmp/evidence/release-acceptance.mjs --template …` 不会写出任何清单，却报告成功。通过链接抵达的 checkout 或 scripts 目录（例如为隔离运行复制到临时目录树中的脚本）同样如此沉默。

`build-provenance.mjs` 早已用 `realpathSync(resolve(process.argv[1]))` 与 `fileURLToPath(import.meta.url)` 比较，因此在 24 个错误写法旁边已经存在一种正确写法。

## Decision

每个桌面脚本在比较前都用 `realpathSync` 解析路径：`import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href`；改用 `fileURLToPath(import.meta.url)` 比较的 5 个脚本则写成 `realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)`。各文件按需补齐 `node:fs` 的 `realpathSync`，以及缺失时 `node:path` 的 `resolve`。

`apps/desktop-tauri/scripts/entry-guard-posture.test.mjs` 守住该不变量，并纳入 `test:update-manifest`。它以被替换的三种写法作为反例夹具予以拒绝；任何脚本的守卫行同时出现 `process.argv[1]` 与 `import.meta.url` 却不含 `realpathSync` 即失败；它要求每个发布关键脚本都有守卫；并通过目录符号链接启动 `release-acceptance.mjs`，断言入口点确实运行、打印出清单模板并选出 beta 目标集。

## Alternatives considered

**保留守卫并写进文档限制。** 静默成功的守卫比明确失败的守卫更糟：操作者看到退出码 0 和空的证据目录。要求「不要使用符号链接路径」也与本仓库「配置错误必须响亮失败」的规则相悖。

**让守卫直接响亮失败而不解析路径。** 这会把验收流程本身鼓励使用的 `/tmp` 与 `$TMPDIR` 常规场景一并拒绝。

**只比较文件名。** 同名脚本会同时认为自己就是入口点。

**同时接受两种比较写法。** 额外接受原始参数比较可以让 `node --preserve-symlinks` 继续通过，但本仓库没有任何启动器设置该标志，而第二种被接受的写法会掩盖本门禁存在所要强制的那一种。

## Consequences

经过任何符号链接路径调用的脚本，现在与经真实路径调用抵达同一入口点，因此按验收 README 操作的人会得到清单模板，而不是空动作的成功。该门禁把「解析真实路径」作为 `apps/desktop-tauri/scripts/` 唯一被接受的写法，并在新脚本回退到更弱比较时点出具体行。

门禁只覆盖 scripts 目录。仓库级 `scripts/` 下的门禁仍只用 `resolve()` 比较路径；入口点契约本身也仍是：被 import 的脚本不得执行其命令行工作。

## Verification

`node --test apps/desktop-tauri/scripts/entry-guard-posture.test.mjs` 在旧守卫写法下失败、在修复后通过：经符号链接调用会打印清单模板，其目标为 `0.0.1-beta.4` 的 `macos-arm64-dmg` 与 `windows-x64-nsis`。在 `apps/desktop-tauri` 下运行 `npm run test:update-manifest` 报告 67 通过、3 跳过、无失败。经 `/var/folders/…`（指向 `/private/var/folders/…` 的符号链接）执行 `release-acceptance.mjs --template --version 0.0.1-beta.4 --commit a506a1bb73ae67bce813c2566726b8c9e0ded763 --upgrade-from 0.0.1-beta.3`，此前无输出，现打印模板并以 0 退出。
