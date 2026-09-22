# Agent Note: 渲染探针的输入

Status: implemented

[English](2026-09-22-render-probe-inputs.md) | 中文

## Problem

`csp-render-verify.yml` 在真实浏览器中渲染打包后的桌面应用，并在窗口空白时失败。它被钉死在单一载荷上：仓库（`NSIETeam/ClawMaster-Desktop`）、run id（`35450188820`）与 artifact 名称都是步骤里的字面量，工作流名称还带着它们构建的版本（`CSP Render Verify (0.0.1-beta.1)`）。

这种钉死让空白窗口检查无法回答它本就是为了回答的问题。2026-09-20 的两次运行说明了它能检测到什么：未打补丁的载荷报出 `RENDER_STATE {"rootChildren":0,"loader":"queue","pending":1,"bodyChars":0}` 与 `CONSOLE_ERRORS []`，并以 `VERDICT: FAIL - blank window` 失败；同一载荷在 `packages/host/frontend-static/lib/index.js` 改两行 CSP（`script-src` 增加 `'unsafe-eval'`、`style-src` 改为 `'unsafe-inline'`）后报出 `{"rootChildren":1,"loader":"live","pending":0,"bodyChars":184}` 并通过。

这两个结果界定了问题范围，却没有回答当前版本线的问题。打补丁用的那一对正是已安装 harness `0.1.5-rc.2` 早已携带的策略；而本仓库的 `packages/host/frontend-static/src/index.ts` 收紧了 `script-src`（不含 `'unsafe-eval'`，由 `b70a42aa91` 引入）与 `style-src`（改用 nonce，由 `0fe355cc30` 引入），且这两个提交都已是 `desktop-v0.2.7` 的祖先。当前源码也在多个 client 包中消费这些注入的 nonce，其 README 声明脚本 nonce 授权 Cordis runner 编译而不启用 `eval`。因此，当前版本线构建后能否渲染尚未被验证，而且没有任何探针可以指向它。

## Decision

`csp-render-verify.yml` 把渲染目标改为输入项：`repository`、`run_id` 与 `artifact`，其中 `run_id` 为必填且没有默认值，以免有人误渲染陈旧载荷。步骤通过 `RENDER_REPOSITORY`、`RENDER_RUN_ID` 与 `RENDER_ARTIFACT` 读取这些输入；下载步骤显式指明仓库，artifact 名称取自输入。探针本身、其判定（`rootChildren > 0 && loader === 'live'`）、截图与 host 日志保持不变，证据仍会在失败时上传。

与 `release-workflow.test.mjs` 并列的 `render-verify-workflow.test.mjs` 固定了这一形态：唯一一个 artifact 下载步骤读取全部三个输入并传入 `--repo "$RENDER_REPOSITORY"`；以空白窗口判定为形状的断言并以非零退出；证据在 `if: always()` 下上传。其反向样例正是本次改动移除的钉死形态——历史字面量载荷、硬编码仓库、以及两个下载步骤——因此该检查被证实会拒绝它所禁止的东西。

## Alternatives considered

**保留钉死的探针，只对旧载荷派发。** 那样它会一直对一个没人发布的载荷报告空白窗口，而对即将发布的候选版本一言不发。

**改为把渲染断言加进发布构建的已安装应用步骤。** 这样检查就位于发布流程无法跳过的地方，但它会在每个平台本已长达 90 分钟的构建任务里再跑一次浏览器断言，且无法对已构建完成的 run 单独派发。参数化探针可以在不重新构建的前提下验证已完成的候选版本，因此它是先回答该问题的更小改动。

**在同一改动里把 CSP 改成打补丁用的那一对。** A/B 表明那一对能让旧载荷渲染，但 `'unsafe-eval'` 是本仓库刻意的收紧，且已有为 nonce 策略编写的消费者，而现有证据还无法说明旧载荷究竟需要哪一条指令。基于这样的证据放宽策略，等于用一次未经证实的猜测交换安全姿态；探针正是把猜测变成测量的一步。

## Consequences

验证候选版本现在只需一次声明其 run 的派发：`gh workflow run csp-render-verify.yml -f run_id=<build run> -f artifact=<artifact>`。工作流名称不再暗示版本，因此其结果属于被传入的那个 run。

探针仍然需要 macOS runner、打包好的 dmg、首次启动的 `pnpm install` 以及 Playwright，所以它是一次刻意派发，而不是每次推送的门禁。渲染失败会给出 loader 状态与控制台错误，并上传截图与 host 日志，但它本身不会指出是哪一个 CSP 指令或哪一项客户端特性导致了空白。

## Verification

`node --test apps/desktop-tauri/scripts/render-verify-workflow.test.mjs` 通过：已提交的工作流满足输入、下载、判定与证据规则，每个反向样例都返回预期的违规信息。`apps/desktop-tauri` 的 `npm run test:update-manifest` 已包含该文件。工作流输入已与本注记引用的运行结果对照：`35477587606`（空白）与 `35478591257`（打补丁载荷渲染成功）。
