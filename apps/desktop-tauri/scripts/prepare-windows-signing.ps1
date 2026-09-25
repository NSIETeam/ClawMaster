$ErrorActionPreference = 'Stop'

$pfxBase64 = $env:WINDOWS_SIGNING_PFX
$pfxPassword = $env:WINDOWS_SIGNING_PFX_PASSWORD
$expectedThumbprint = ($env:WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT -replace '\s', '').ToUpperInvariant()
$supplied = @(
  [bool]$pfxBase64,
  [bool]$pfxPassword,
  [bool]$expectedThumbprint
)

if (-not ($supplied | Where-Object { $_ })) {
  "CLAWMASTER_WINDOWS_SIGNED=false" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  "Windows candidate is unsigned; stable publication acceptance will reject it." | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
  exit 0
}
if ($supplied | Where-Object { -not $_ }) { throw 'Windows signing requires the PFX, its password, and the pinned certificate thumbprint.' }
if ($expectedThumbprint -notmatch '^[A-F0-9]{40}$') { throw 'WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT must be a 40-character SHA-1 certificate thumbprint.' }
if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV -or -not $env:GITHUB_STEP_SUMMARY) { throw 'GitHub Actions runner paths are required.' }

$pfxPath = Join-Path $env:RUNNER_TEMP 'clawmaster-signing.pfx'
$configPath = Join-Path $env:RUNNER_TEMP 'clawmaster-windows-signing.json'
try {
  try { $pfxBytes = [Convert]::FromBase64String($pfxBase64) } catch { throw 'WINDOWS_SIGNING_PFX must be base64-encoded PFX bytes.' }
  if ($pfxBytes.Length -eq 0) { throw 'WINDOWS_SIGNING_PFX must not be empty.' }
  [IO.File]::WriteAllBytes($pfxPath, $pfxBytes)
  $securePassword = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
  $null = Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation 'Cert:\CurrentUser\My' -Password $securePassword
  $certificate = Get-ChildItem 'Cert:\CurrentUser\My' | Where-Object { $_.Thumbprint -eq $expectedThumbprint } | Select-Object -First 1
  if (-not $certificate) { throw 'The imported PFX does not contain the pinned signing certificate.' }
  if (-not $certificate.HasPrivateKey) { throw 'The imported signing certificate has no private key.' }
  $now = Get-Date
  if ($now -lt $certificate.NotBefore -or $now -gt $certificate.NotAfter) { throw 'The Windows signing certificate is outside its validity period.' }
  $eku = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | Select-Object -First 1
  if (-not $eku -or $eku.EnhancedKeyUsages.Value -notcontains '1.3.6.1.5.5.7.3.3') { throw 'The Windows certificate does not allow code signing.' }

  $config = @{ bundle = @{ windows = @{ certificateThumbprint = $expectedThumbprint; digestAlgorithm = 'sha256'; timestampUrl = 'http://timestamp.digicert.com' } } }
  $json = $config | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($configPath, $json, [Text.UTF8Encoding]::new($false))
  "CLAWMASTER_WINDOWS_SIGNING_CONFIG=$configPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  "CLAWMASTER_WINDOWS_SIGNED=true" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  "WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT=$expectedThumbprint" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  "Windows signing certificate imported and pinned to $expectedThumbprint." | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
}
finally {
  if (Test-Path -LiteralPath $pfxPath) { Remove-Item -LiteralPath $pfxPath -Force }
  if ($null -ne $pfxBytes) { [Array]::Clear($pfxBytes, 0, $pfxBytes.Length) }
}
