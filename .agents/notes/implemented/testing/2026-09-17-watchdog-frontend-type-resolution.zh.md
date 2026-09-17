# Agent Note：WatchDog 前端针对已构建的工作区声明进行类型检查

Status: implemented

[English](2026-09-17-watchdog-frontend-type-resolution.md) | 中文

## 问题

独立 npm 前端在 DSH 工作区项目图之外编译。其客户端源码使用由运行时注入的 DSH 包，因此仅执行 npm 安装并不能提供全部工作区 API 类型。若一部分导入来自 npm 包，另一部分来自仓库，还会造成品牌类型不兼容。

## 决策

[`frontends/dsh/tsconfig.typecheck.json`](../../../../frontends/dsh/tsconfig.typecheck.json) 将每个已导入的 DSH API 映射到其所属工作区包的构建声明。`dsh-session/types` 映射到 DSH Session 类型所使用的同一声明模块，因此 Agent 事件扩展会合并进 Session 事件联合类型。桌面发布工作流会先构建 DSH 工作区，再检查此前端类型。

专用配置会避免这些路径影响前端测试运行器的运行时解析。前端 bundle 仍将 DSH 运行时导入留给 DSH 声明的注入机制。

## 考虑过的替代方案

**从独立 npm 安装解析所有包。** 这些版本可能与 DSH 工作区构建不同，使品牌 ID 具有彼此独立的 TypeScript 类型身份。

**继承 DSH 基础 TypeScript 项目。** 其中的工作区源码别名会将前端项目以外的文件引入 composite TypeScript 程序。前端改为检查工作区构建出的公开声明。

## 影响

前端类型检查会针对同一发布源码生成的声明验证其 DSH API。包目录或声明入口发生变化时，必须同步更新此映射。此映射不会改变包注入机制或 bundle 内容。
