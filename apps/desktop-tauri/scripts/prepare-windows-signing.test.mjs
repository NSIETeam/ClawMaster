import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./prepare-windows-signing.ps1', import.meta.url))
const pwsh = process.env.CLAWMASTER_TEST_PWSH ?? 'pwsh'
const probe = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' })
const available = process.platform === 'win32' && !probe.error && probe.status === 0

test('Windows signing setup handles absent, incomplete and certificate-backed runner configuration', { skip: available ? false : 'Windows certificate cmdlets are unavailable on this platform' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'ClawMaster Windows signing '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const githubEnv = join(root, 'github-env')
  const summary = join(root, 'summary')
  const pfxPath = join(root, 'fixture.pfx')
  writeFileSync(githubEnv, '')
  writeFileSync(summary, '')
  const baseEnv = { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: githubEnv, GITHUB_STEP_SUMMARY: summary }
  const run = env => spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
    encoding: 'utf8', env: { ...baseEnv, ...env }, timeout: 30000,
  })

  const unsigned = run({ WINDOWS_SIGNING_PFX: '', WINDOWS_SIGNING_PFX_PASSWORD: '', WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT: '' })
  assert.equal(unsigned.status, 0, unsigned.stderr)
  assert.match(readFileSync(githubEnv, 'utf8'), /CLAWMASTER_WINDOWS_SIGNED=false/u)

  const incomplete = run({ WINDOWS_SIGNING_PFX: 'cA==', WINDOWS_SIGNING_PFX_PASSWORD: '', WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT: '' })
  assert.notEqual(incomplete.status, 0)
  assert.match(incomplete.stderr, /requires the PFX/u)

  const fixture = execFileSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', [
    "$password = ConvertTo-SecureString 'fixture-password' -AsPlainText -Force",
    "$certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=ClawMaster workflow fixture' -CertStoreLocation 'Cert:\\CurrentUser\\My'",
    `Export-PfxCertificate -Cert $certificate -FilePath '${pfxPath.replaceAll("'", "''")}' -Password $password | Out-Null`,
    'Write-Output $certificate.Thumbprint',
  ].join('; ')], { encoding: 'utf8' }).trim()
  t.after(() => { spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Remove-Item 'Cert:\\CurrentUser\\My\\${fixture}' -ErrorAction SilentlyContinue`]) })
  const encoded = readFileSync(pfxPath).toString('base64')
  const configured = run({ WINDOWS_SIGNING_PFX: encoded, WINDOWS_SIGNING_PFX_PASSWORD: 'fixture-password', WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT: fixture })
  assert.equal(configured.status, 0, configured.stderr)
  const environment = readFileSync(githubEnv, 'utf8')
  assert.match(environment, /CLAWMASTER_WINDOWS_SIGNED=true/u)
  const configPath = environment.match(/CLAWMASTER_WINDOWS_SIGNING_CONFIG=(.+)/u)?.[1]
  assert.ok(configPath)
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
    bundle: { windows: { certificateThumbprint: fixture, digestAlgorithm: 'sha256', timestampUrl: 'http://timestamp.digicert.com' } },
  })
})
