# Agent Note: 桌面 Node 预加载模块的文件 URL

Status: implemented

[English](2026-09-13-desktop-node-preload-file-url.md) | 中文

## 问题

Node 将 `--import C:\...` 中的 Windows 原生盘符前缀解释为不支持的 URL 协议。未转义的 `#` 和 `%` 也会改变模块解析。桌面预加载模块先于普通 Web profile 运行，因此此错误会阻止已安装的 Windows 应用进入 Host 启动流程。

## 决策

原生 supervisor 使用已有的 `url::Url::from_file_path` API 转换预加载模块的绝对路径，将序列化后的文件 URL 传给 Node。转换失败时在创建 Host 进程前报告预加载模块路径，不回退到原始路径。Profile 预配测试和已安装 Host 测试对同一参数使用 Node 的 `pathToFileURL`。

此转换由进程启动器负责。它不改变 profile 数据、受支持的 `dsh web` 入口或 [patch 插件 URL 解析](2026-09-05-patch-plugin-file-urls.zh.md)；后者负责 Cordis patch 中的路径。WSL 向 Linux Node 传入 Linux 路径，保留现有启动参数。

## 考虑过的替代方案

**只转换测试参数。** 生产 supervisor 传入相同的原生路径，即使测试通过，Windows 仍会启动失败。

**手动为路径添加 `file://` 前缀。** 盘符、分隔符和 URL 分隔字符需要已有 URL 库提供的平台感知编码。

## 影响

Rust 测试要求原生路径往返转换、URL 分隔字符编码及对相对 harness 目录的明确拒绝。预配测试从包含空格、中文、`#` 和 `%` 的临时目录执行预加载模块；已安装 Host 冒烟测试验证正常认证的 Web profile 与重启。Windows 执行仍由发布矩阵验证，本机 macOS 通过不能替代它。
