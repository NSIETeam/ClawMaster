# Agent Note: 发布 job 挂在了一个必然跳过自己的 needs 列表上

Status: implemented

[English](2026-09-23-release-publication-needs-deadlock.md) | 中文

## 问题

提交 e1e9a39142 给发布加上了隔离安装渲染验证门禁，并给 `release` job 加了 `needs: [build, isolated-install-verify]`。在发布 dispatch（`inputs.publish == true`）时，`build` job 自身的 `if` 求值为 false，GitHub 会把该跳过沿 `needs` 传播，`release` job 因此永远无法运行：`desktop-v0.0.1-beta.*` 的发布通道不可达。工作流结构测试抓住了这个回归（`desktop-v0.0.1-beta.5` 标签上 `test:update-manifest` 失败，run 35694280715 与 35695387437），而过时的断言掩盖了更深的语义破坏。

## 决策

`release` job 恢复为不带 `needs`，与渲染门禁提交之前一致：发布 dispatch 通过 `inputs.build_run_id` 消费原始候选构建的产物，dispatch run 里任何东西都不应经由 `needs` 卡它。白屏门禁不变、双重生效：`isolated-install-verify` 在每次候选构建上运行（在那里它 needs `build`），发布侧的 `verify-release-build-run.mjs` 要求候选 run 整体 `conclusion` 为 `success`——渲染门禁失败即无从通过。结构测试现在同时钉住两个事实：`release.needs` 为 `undefined`，`isolated-install-verify.needs` 为 `build`。

## 备选方案

**保留 `needs` 并给 release job 加 `always()` 式条件。** 否决：门禁强制已由 `verify-release-build-run.mjs` 承担，这样做是重复，且依赖图继续误导——release job 消费的是另一个 run 的产物，needs 本次 run 的 job 什么也保护不了。

**在发布 dispatch 里重新构建并验证。** 否决：发布必须消费经过不可变候选验收的字节；在发布 run 里重建等于发布从未被验收过的产物。

## 后果

`desktop-v0.0.1-beta.*` 标签的手动发布恢复可用，同时白屏门禁保留在每次候选构建上。它防范的故障模式——有人重新加回 `needs` 导致发布被静默跳过——现在是一条会红的测试，而不是发布时的意外。
