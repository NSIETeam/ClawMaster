# GitHub Actions Workflows

ClawMaster 当前正式桌面交付链路走 Tauri v2。仓库仍保留从 Otto 继承的
Electron/企业发布工作流作为兼容基线，但它已被仓库条件限制到
`NSIETeam/otto-new`，不得作为 ClawMaster 正式发布路径。

发布前必须先完成本地门禁：

```bash
npm run doctor
git diff --check
npm run code-map:check
npm --workspace packages/desktop run release:gate
```

## Tauri Release Build

文件：`.github/workflows/tauri-preview.yml`

触发：

- push 到 `main`
- push 到 `codex/windows-*`
- push tag：`v*.*.*`
- 手动 `workflow_dispatch`

主要产物：

- `ClawMaster_<version>_aarch64.dmg`
- `ClawMaster_<version>_x64.dmg`
- Windows x64 NSIS 安装器
- 每个平台的 `SHA256SUMS`

核心门禁：

- 使用 Node `24.20.0` 和 Tauri v2 构建。
- 下载并验证 Tauri Node runtime 与 SQLCipher native assets。
- 运行 self-modification 聚焦测试，覆盖 build、activate、observe、rollback、IPC、
  candidate supervisor、task coordinator、version registry 与 infrastructure。
- 构建后运行 `npm --workspace packages/desktop run release:formal:gate`，确认正式版本号、
  ClawMaster 品牌、旧 Otto/Electron release 隔离，以及当前平台下载包不超过 30 MiB。
- macOS DMG 会被创建、优化、挂载，并验证完整 Agent runtime、SQLCipher、文档 worker、
  不携带 npm/package manager/build cache。
- Windows 安装器会被静默安装到临时目录，使用隔离 `OTTO_USER_DIR` 启动 GUI smoke，
  不覆盖现有用户数据。

tag `v*.*.*` 触发时，成功的 Tauri workflow 会发布正式 GitHub Release；手动触发时可
选择 draft / prerelease。

## SQLCipher native assets

文件：`.github/workflows/sqlcipher-native.yml`

这个 workflow 也会独立触发，用于生成和验证多平台 native matrix。Tauri Release Build
通过 reusable workflow 引用同一套资产，避免打包时混用旧安装包中的 native binding。

## Tauri Node runtime

文件：`.github/workflows/tauri-node-runtime.yml`

生成 macOS arm64、macOS x64、Windows x64 的最小 Node runtime。最终下载包不允许携带
npm、npx、corepack、Electron builder、webpack、eslint、vitest 或构建缓存。

## Legacy Otto/Electron Release Build

文件：`.github/workflows/release.yml`

该 workflow 来自 Otto 发布链路，仍包含 `Otto-*` 产物、企业部署、更新镜像和旧客户端
兼容逻辑。ClawMaster 仓库中它必须被 `github.repository == 'NSIETeam/otto-new'` 护栏
拦住；如果在 ClawMaster 中运行，说明发布边界回退了，应立即修复。

ClawMaster 桌面默认命令已经切到 Tauri：

```bash
npm --workspace packages/desktop run release
npm --workspace packages/desktop run release:gate
```

旧 Electron 聚合路径只能显式调用：

```bash
npm --workspace packages/desktop run release:legacy:electron
npm --workspace packages/desktop run release:legacy:gate
```

## Known infrastructure blocker

如果 GitHub Actions run 在 3-8 秒内失败，所有 job 都显示 `steps: []`，并且 check-run
annotation 是：

> The job was not started because recent account payments have failed or your spending limit needs to be increased.

这不是代码、workflow YAML、Tauri 或 SQLCipher 编译失败，而是 GitHub Billing / Actions
spending limit 阻止 runner 启动。处理 Billing 后可以 rerun 对应 workflow；不要在没有
新日志的情况下盲目修改构建代码。
