# Agent Note: Linux 不可变运行时资源

Status: implemented

[English](2026-09-13-linux-immutable-runtime-resources.md) | 中文

## 问题

Linuxdeploy 会递归检查 AppImage 的 `usr/lib` 下的 ELF 文件。桌面运行时包含 glibc `ldd` 无法检查的 musl Node 扩展。检查成功后还会安排修改 RPATH，因此将原生运行时资源放在该目录会改变运行时 manifest 校验覆盖的字节。

## 决策

Linux AppImage 和 Debian 包通过 Tauri 针对安装包的 `files` 映射，将完整的已准备运行时放到 `usr/share/ClawMaster/harness-source`。Linux 配置使用 Tauri 的 JSON Merge Patch，仅移除全局 harness 资源映射。运行时从 Tauri 资源目录推导共享数据目录，并要求其中存在 bundle manifest。Linux 开发构建可以读取以编译时 Cargo manifest 目录为基准的已准备源码目录。

两种 libc 扩展、静态 Landlock 启动器及完整的 DSH 源码和插件载荷全部保留。内容哈希继续标识不可变运行时，不受安装包内位置影响。[源码预配](../feature/2026-08-14-cross-platform-desktop-source-provisioning.zh.md)仍负责可写安装目录及受支持的 Host 启动。

## 考虑过的替代方案

**传入 `--exclude-library`。** Linuxdeploy 在复制依赖库时应用该选项，此时现有资源扫描已经选中了每个 ELF 文件。它无法将内嵌扩展排除在检查之外。

**删除 musl 扩展。** 这可以避免一次不兼容检查，但其他原生资源仍会被修改 RPATH。迁移完整运行时能够保留其字节和原生能力。

**放宽载荷哈希检查。** 这会隐藏打包期间的修改，并削弱源码到安装产物的证据。

## 影响

Linux 安装包映射与运行时路径解析必须一致。产物验证器将解包后的 AppImage 和 Debian 载荷与原始已准备运行时的 manifest 和哈希核对，要求存在两种原生扩展和可执行的沙箱启动器，并拒绝在 `usr/lib` 下出现第二份运行时。生产安装和已认证 Host 重启测试使用这些解包载荷的副本；只验证已准备目录不能证明安装产物完整。
