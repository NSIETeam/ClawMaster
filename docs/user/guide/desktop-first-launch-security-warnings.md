# Resolve first-launch security warnings

English | [中文](desktop-first-launch-security-warnings.zh.md)

This guide explains how to check ClawMaster's installer and respond to macOS Gatekeeper or Windows SmartScreen warnings without turning off system protection.

## Verify the installer first

Download the installer and `SHA256SUMS.txt` only from the [official ClawMaster Desktop releases](https://github.com/NSIETeam/ClawMaster-Desktop/releases).

On macOS, open Terminal in Downloads and calculate the installer hash:

```sh
cd ~/Downloads
shasum -a 256 clawmaster-*-macos-arm64.dmg
```

On Windows, open PowerShell in Downloads and calculate the installer hash:

```powershell
$installer = Get-ChildItem -File -Filter 'clawmaster-*-windows-x64-setup.exe'
if ($installer.Count -ne 1) { throw 'Keep exactly one matching installer in this folder.' }
Get-FileHash $installer.FullName -Algorithm SHA256
```

Compare the 64-character hash with the entry for the same filename in `SHA256SUMS.txt`. Stop if the file is absent or the values differ. A matching checksum confirms that the downloaded bytes match that release manifest; it does not establish a verified publisher identity.

## macOS Gatekeeper

Try to open ClawMaster once from Finder. If macOS says it cannot check the app for malicious software or the developer cannot be verified, choose **Done**, then open **System Settings → Privacy & Security** and scroll to **Security**.

Choose **Open Anyway** for ClawMaster, confirm the warning when it appears again, and authenticate if macOS requests it. This option appears after the first launch attempt and is available for about an hour.

If macOS says the app will damage your computer or identifies malware, stop and do not open it. Do not disable Gatekeeper or remove the app's quarantine attribute.

See Apple's guide to [opening an app from an unidentified developer](https://support.apple.com/en-mo/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

## Windows SmartScreen

Run the downloaded installer. If Microsoft Defender SmartScreen shows **Windows protected your PC**, select **More info** and then **Run anyway** only after the installer hash matches the official release manifest.

The installer is not Authenticode-signed, so Windows may show an unknown publisher. If SmartScreen does not offer **Run anyway**, or Microsoft Defender reports a threat, stop and contact your administrator or ClawMaster support. Do not turn off SmartScreen, Defender, or organization security policy.

See Microsoft's guidance on [SmartScreen app reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

## What these steps do not verify

The current macOS installer is ad-hoc signed and is not notarized by Apple; the Windows installer has no Authenticode signature. The checksum and these one-time overrides do not create a publisher identity or replace Apple's malware review. If the warning does not match the cases above, do not continue.
