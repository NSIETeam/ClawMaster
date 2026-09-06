param(
  [Parameter(Mandatory = $true)]
  [string]$Installer
)

$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path $Installer).Path
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$smokeRoot = Join-Path $env:RUNNER_TEMP "clawmaster-windows-smoke-$PID"
$installRoot = Join-Path $smokeRoot 'install'
$userRoot = Join-Path $smokeRoot 'user'
$appDataRoot = Join-Path $smokeRoot 'appdata'
$localAppDataRoot = Join-Path $smokeRoot 'localappdata'
$evidencePath = Join-Path $repoRoot 'packages/desktop/src-tauri/target/release/windows-installed-smoke.json'
$appProcess = $null
$previousUserRoot = $env:CLAWMASTER_USER_DIR
$previousAppData = $env:APPDATA
$previousLocalAppData = $env:LOCALAPPDATA

New-Item -ItemType Directory -Force -Path $installRoot, $userRoot, $appDataRoot, $localAppDataRoot | Out-Null

function Get-SmokeProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.Contains($userRoot, [System.StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.Contains($appDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.Contains($localAppDataRoot, [System.StringComparison]::OrdinalIgnoreCase))
  })
}

try {
  Write-Host "[tauri-windows] installing $installerPath into $installRoot"
  $install = Start-Process -FilePath $installerPath `
    -ArgumentList @('/S', "/D=$installRoot") `
    -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "NSIS silent install failed with exit code $($install.ExitCode)"
  }

  $app = Get-ChildItem -Path $installRoot -Filter 'clawmaster-desktop.exe' -Recurse |
    Select-Object -First 1
  if (-not $app) {
    throw "clawmaster-desktop.exe was not installed below $installRoot"
  }

  Write-Host "[tauri-windows] verifying installed runtime"
  node (Join-Path $repoRoot 'packages/desktop/scripts/verify-tauri-bundle.mjs') $installRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Installed runtime verification failed with exit code $LASTEXITCODE"
  }

  $env:CLAWMASTER_USER_DIR = $userRoot
  $env:APPDATA = $appDataRoot
  $env:LOCALAPPDATA = $localAppDataRoot
  Write-Host "[tauri-windows] starting installed GUI from $($app.FullName)"
  $appProcess = Start-Process -FilePath $app.FullName -PassThru
  Start-Sleep -Seconds 8
  $appProcess.Refresh()
  if ($appProcess.HasExited) {
    throw "Installed ClawMaster exited during startup with code $($appProcess.ExitCode)"
  }
  if ($appProcess.MainWindowHandle -eq 0) {
    throw "Installed ClawMaster did not expose a main window"
  }

  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($appProcess.Id)")
  $evidence = [ordered]@{
    schemaVersion = 1
    platform = 'windows-x64'
    installer = Split-Path -Leaf $installerPath
    executable = $app.Name
    pid = $appProcess.Id
    windowReady = $true
    workingSetBytes = $appProcess.WorkingSet64
    cpuSeconds = $appProcess.TotalProcessorTime.TotalSeconds
    childProcessCount = $children.Count
    gracefulExit = $false
    orphanProcessCount = $null
  }

  if (-not $appProcess.CloseMainWindow()) {
    throw "Installed ClawMaster rejected the normal window-close request"
  }
  if (-not $appProcess.WaitForExit(10000)) {
    throw "Installed ClawMaster did not exit within 10 seconds after a normal close request"
  }
  $evidence.gracefulExit = $true
  Start-Sleep -Seconds 3
  $remaining = @(Get-SmokeProcesses)
  $evidence.orphanProcessCount = $remaining.Count
  $evidence | ConvertTo-Json | Set-Content -LiteralPath $evidencePath -Encoding utf8
  if ($remaining.Count -ne 0) {
    $remainingSummary = ($remaining | ForEach-Object { "$($_.ProcessId):$($_.Name)" }) -join ', '
    throw "Installed ClawMaster left owned processes after exit: $remainingSummary"
  }

  $appProcess = $null
  Write-Host "[tauri-windows] installed startup, normal exit, and orphan-process checks passed"
  Write-Host "[tauri-windows] evidence: $evidencePath"
} finally {
  if ($appProcess -and -not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force
    Wait-Process -Id $appProcess.Id -ErrorAction SilentlyContinue
  }
  foreach ($process in @(Get-SmokeProcesses)) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $env:CLAWMASTER_USER_DIR = $previousUserRoot
  $env:APPDATA = $previousAppData
  $env:LOCALAPPDATA = $previousLocalAppData
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
