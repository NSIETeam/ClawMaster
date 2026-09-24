# 处理首次启动安全提示

[English](desktop-first-launch-security-warnings.md) | 中文

本指南说明如何核对 ClawMaster 安装包，并在 macOS Gatekeeper 或 Windows SmartScreen 显示提示时继续操作，同时保留系统防护。

## 先核对安装包

只从 [ClawMaster Desktop 官方发布页](https://github.com/NSIETeam/ClawMaster-Desktop/releases)下载安装包和 `SHA256SUMS.txt`。

在 macOS 上打开“下载”目录中的终端，计算安装包摘要：

```sh
cd ~/Downloads
shasum -a 256 clawmaster-*-macos-arm64.dmg
```

在 Windows 上打开“下载”目录中的 PowerShell，计算安装包摘要：

```powershell
$installer = Get-ChildItem -File -Filter 'clawmaster-*-windows-x64-setup.exe'
if ($installer.Count -ne 1) { throw 'Keep exactly one matching installer in this folder.' }
Get-FileHash $installer.FullName -Algorithm SHA256
```

将输出的 64 位摘要与 `SHA256SUMS.txt` 中同名文件的记录比较。如果没有对应记录或摘要不同，请停止安装。摘要一致只能确认下载字节与该发布清单相符，不能证明发布者身份已通过系统验证。

## macOS Gatekeeper

先在 Finder 中尝试打开一次 ClawMaster。如果 macOS 提示无法检查应用是否含恶意软件，或无法验证开发者，请选择**完成**，然后打开**系统设置 → 隐私与安全性**并滚动到**安全性**。

为 ClawMaster 选择**仍要打开**，并在提示再次出现时确认；如果 macOS 要求验证身份，请按系统提示操作。首次尝试启动后才会显示此选项，通常约一小时内可用。

如果 macOS 提示应用会损害电脑或检测到恶意软件，请停止操作，不要打开。不要关闭 Gatekeeper，也不要移除应用的隔离属性。

参阅 Apple 关于[打开来自身份不明开发者的应用](https://support.apple.com/en-mo/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)的说明。

## Windows SmartScreen

运行下载的安装包。如果 Microsoft Defender SmartScreen 显示“Windows 已保护你的电脑”，只有在安装包摘要与官方发布清单相符后，才选择**更多信息**，再选择**仍要运行**。

安装包没有 Authenticode 签名，因此 Windows 可能显示发布者未知。如果 SmartScreen 没有提供**仍要运行**，或 Microsoft Defender 报告检测到威胁，请停止并联系管理员或 ClawMaster 支持。不要关闭 SmartScreen、Defender 或组织安全策略。

参阅 Microsoft 关于 [SmartScreen 应用信誉](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)的说明。

## 这些步骤不能证明什么

当前 macOS 安装包使用临时签名，尚未经过 Apple 公证；Windows 安装包没有 Authenticode 签名。校验和与一次性放行不会建立发布者身份，也不能替代 Apple 的恶意软件检查。如果遇到的提示与上文不同，请不要继续。
