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
$appProcess = $null

New-Item -ItemType Directory -Force -Path $installRoot, $userRoot | Out-Null

try {
  $install = Start-Process -FilePath $installerPath `
    -ArgumentList @('/S', "/D=$installRoot") `
    -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "NSIS silent install failed with exit code $($install.ExitCode)"
  }

  $app = Get-ChildItem -Path $installRoot -Filter 'ClawMaster.exe' -Recurse |
    Select-Object -First 1
  if (-not $app) {
    throw "ClawMaster.exe was not installed below $installRoot"
  }

  node (Join-Path $repoRoot 'packages/desktop/scripts/verify-tauri-bundle.mjs') $installRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Installed runtime verification failed with exit code $LASTEXITCODE"
  }

  $previousUserRoot = $env:OTTO_USER_DIR
  $env:OTTO_USER_DIR = $userRoot
  $appProcess = Start-Process -FilePath $app.FullName -PassThru
  Start-Sleep -Seconds 8
  if ($appProcess.HasExited) {
    throw "Installed ClawMaster exited during startup with code $($appProcess.ExitCode)"
  }

  Write-Host "[tauri-windows] installed runtime and fresh GUI startup passed: $($app.FullName)"
} finally {
  if ($appProcess -and -not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force
    Wait-Process -Id $appProcess.Id -ErrorAction SilentlyContinue
  }
  $env:OTTO_USER_DIR = $previousUserRoot
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
