# Agent Note：延迟执行 Loader 配置表达式

Status: implemented

[English](2026-09-24-lazy-loader-expression-evaluation.md) | 中文

## 问题

浏览器 bundle 导入配置 Loader 时，模块初始化会创建 `Function`，即使配置中没有 `!!js` 表达式。桌面 WebView 的内容安全策略会拒绝动态代码构造，导致应用渲染前客户端模块加载中断。

## 决策

将 evaluator 的创建移入 `evaluate()`，使普通模块导入不会编译动态代码。显式调用该 API 的配置仍可求值。不在浏览器策略中加入 `unsafe-eval`。`apps/web/tests/loader-import-csp.e2e.ts` 使用生产策略提供的真实 Chromium 页面导入 evaluator，并断言模块加载成功且浏览器没有错误。

## 考虑过的替代方案

**在浏览器策略中允许 `unsafe-eval`：**这会允许页面各处动态编译，并削弱现有策略。**按需创建 evaluator：**普通启动可继续遵守现有策略，因此采用此方案。

## 结果

普通浏览器启动不再编译 evaluator。显式求值表达式仍需运行环境允许动态代码；浏览器策略保持严格。
