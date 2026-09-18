# Agent Note: 桌面版本唯一来源

Status: implemented

[English](2026-09-18-desktop-version-single-source.md) | 中文

## Problem

桌面包清单、Cargo 清单和 Tauri 配置分别保存了发布版本。安装包命名与发布证据通过不同构建路径读取这些值，因此只修改其中一处可能导致安装包显示的版本与元数据或证据不一致。

## Decision

`apps/desktop-tauri/version.json` 是桌面发布版本的唯一来源。`npm run version:sync` 会生成 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 中的 `version` 字段；`npm run version:check` 会拒绝任何不一致。Tauri 前端准备阶段会在创建 `dist` 或打包源码前执行检查。Cargo 构建脚本还会独立对比规范版本及三个生成版本，因此直接执行原生构建也会在版本漂移时失败。

安装包版本元数据来自 Cargo，bundle 来源记录和发布验收则接收桌面 package 版本。两者都由同一文件生成，并在 Tauri 构建前检查；发布标签校验器也会要求 package 与 Tauri 版本一致。同步命令只修改版本字段，并保留清单中的其他内容。

## Alternatives considered

**继续手动维护三个版本值，只在发布验收时比较。** 这种方式仍允许本地 Tauri 构建和直接 Cargo 构建产生版本不一致的产物。版本生成器和构建时检查会在任一打包路径完成前拒绝漂移。

**让安装包、来源记录和验收分别直接读取规范文件。** Cargo 与 Tauri 需要各自清单中的版本来写入原生元数据。生成这些必需值，并在两个构建入口校验，既提供原生工具链所需的输入，也保留唯一可编辑的发布版本。

## Consequences

维护者在 `version.json` 中修改版本，并在 `apps/desktop-tauri` 运行 `npm run version:sync`，然后再进行构建。正向样例会验证版本同步；反向样例分别修改每个生成版本，并要求构建检查拒绝。发行说明和说明文档仍是手工维护的记录，应随版本更新；它们不决定打包产品的身份。

## Verification

`scripts/desktop-version.test.mjs` 会验证版本一致性、拒绝每份生成清单中的漂移、确定性地修复漂移，并验证规范版本无效时不会修改生成文件。`prepare-dist.mjs` 会执行检查，`src-tauri/build.rs` 会在 Cargo 构建时再次执行。上述检查可以防止源码版本漂移，但不能证明平台安装包已在真实支持设备上签名、安装、重启或回滚。
