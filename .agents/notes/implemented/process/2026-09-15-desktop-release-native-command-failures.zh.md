# Agent Note: 在首个原生命令错误处终止桌面发布步骤

Status: implemented

[English](2026-09-15-desktop-release-native-command-failures.md) | 中文

## 问题

PowerShell 的默认错误偏好不会在原生可执行文件非正常退出时停止脚本。后续命令覆盖 `$LASTEXITCODE` 后，GitHub 的最终检查可能报告成功。组件测试失败必须阻止同一步骤中的后续构建或发布工作。

## 决策

[桌面发布工作流](../../../../.github/workflows/desktop-release.yml) 的每个 Windows 可达构建步骤都使用原生 PowerShell。每个 PowerShell 步骤（包括发布检查）均要求 7.4 或更高版本，并在执行命令前显式设置 `$ErrorActionPreference = 'Stop'` 和 `$PSNativeCommandUseErrorActionPreference = $true`。Actions 为每个步骤启动独立 shell，因此每个步骤自行设置这些偏好。仅供 macOS/Linux 使用的 Bash 步骤保留其 shell 的失败处理。

## 考虑过的替代方案

**只检查最后一个退出码。** 后续命令成功时，这会丢失此前的失败。

**在每次原生调用后手动检查退出码。** 这种方式有效，但要求每个新增命令都配套自己的检查。统一的 PowerShell 行为无需自定义执行包装器，就能覆盖新增命令。

## 影响

每个原生命令的非零退出都会终止步骤，除非明确限定范围的操作处理了有文档说明的非错误退出码。工作流不会仅因 stderr 上出现诊断输出就判定命令失败。

[工作流回归测试](../../../../apps/desktop-tauri/scripts/release-workflow.test.mjs) 使用隔离的原生命令替身执行已提交的命令序列与偏好设置。失败调用必须阻止后续调用，并产生非零 shell 退出；关闭该偏好必须复现误报成功的退出。托管 CI 要求使用 PowerShell 执行此检查。这些合成命令失败证明的是 shell 错误传播，不是产品行为或原生 Windows 安装验收。
