/** Build-only dispatch retains release checks without publishing or moving Latest. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'

const workflow = load(readFileSync(new URL('../../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8'))

test('the committed desktop lock is unambiguous and includes graph persistence', () => {
  const lock = load(readFileSync(new URL('../pnpm-desktop-lock.yaml', import.meta.url), 'utf8'))
  for (const name of ['dsh', 'notes', 'office', 'guard', 'graph-memory', 'rpa', 'updates']) {
    assert.ok(lock.importers[`frontends/${name}`], name)
  }
  assert.equal(lock.importers['frontends/graph-memory'].dependencies['@deepseek-ai/dsh-storage-sqlite'].version,
    'link:../../packages/storage/storage-sqlite')
})

test('manual validation defaults to an immutable branch build without publication', () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.type, 'boolean')
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false)
  assert.equal(workflow.jobs.build.if, "github.event_name == 'push' || inputs.publish != true")
  assert.equal(workflow.jobs.build.needs, 'plan-build')
  assert.equal(workflow.jobs['plan-build'].outputs.matrix, '${{ steps.matrix.outputs.matrix }}')
  assert.equal(workflow.jobs.build.strategy.matrix, '${{ fromJSON(needs.plan-build.outputs.matrix) }}')
  assert.match(workflow.jobs['plan-build'].steps.find(step => step.name === 'Select builders from the explicit tag').run, /release-build-matrix\.mjs/u)
  assert.equal(workflow.jobs.release.if, "github.event_name == 'workflow_dispatch' && inputs.publish == true")
  assert.equal(workflow.jobs.release.needs, undefined)
  assert.equal(workflow.jobs.release.environment, 'desktop-release')
  assert.equal(workflow.jobs.release.permissions.actions, 'read')
  assert.equal(workflow.jobs.release.permissions.contents, 'write')
  assert.equal(workflow.on.workflow_dispatch.inputs.build_run_id.type, 'string')
  assert.equal(workflow.on.workflow_dispatch.inputs.acceptance_ref.type, 'string')
  const releaseSteps = workflow.jobs.release.steps
  assert.ok(!releaseSteps.some(step => step.uses === 'actions/download-artifact@v4' && !step.with))
  const originalArtifacts = releaseSteps.filter(step => step.uses === 'actions/download-artifact@v4')
  assert.equal(originalArtifacts.length, 3)
  for (const step of originalArtifacts) {
    assert.equal(step.with['run-id'], '${{ inputs.build_run_id }}')
    assert.equal(step.with['github-token'], '${{ github.token }}')
  }
  assert.deepEqual(originalArtifacts.slice(1).map(step => step.with.name), ['macos-arm64-native-acceptance', 'windows-native-acceptance'])
  assert.match(releaseSteps.find(step => step.name === 'Check the original successful candidate build run').run, /verify-release-build-run\.mjs/)
  assert.doesNotMatch(releaseSteps.find(step => step.name === 'Check the original successful candidate build run').run, /\$\{\{ inputs\.build_run_id \}\}/u)
  assert.match(releaseSteps.find(step => step.name === 'Add reviewed acceptance manifest and evidence').run, /copy-release-evidence\.mjs/)
  assert.doesNotMatch(releaseSteps.find(step => step.name === 'Validate publication inputs').run, /\$\{\{ inputs\./u)
  assert.equal(workflow.jobs.release.steps.find(step => step.uses === 'actions/checkout@v6' && !step.with.path).with.ref, '${{ env.RELEASE_TAG }}')
  assert.match(releaseSteps.find(step => step.uses === 'actions/checkout@v6' && step.with.path === 'acceptance-input').with.ref, /^\$\{\{ inputs\.acceptance_ref \}\}$/u)
  const checkout = workflow.jobs.build.steps.find(step => step.uses === 'actions/checkout@v6')
  assert.equal(checkout.with.ref, '${{ github.event_name == \'workflow_dispatch\' && !inputs.publish && github.sha || env.RELEASE_TAG }}')
  assert.match(workflow.jobs.release.steps.find(step => step.name === 'Generate updater manifest').run, /--target-set '\$\{\{ steps\.channel\.outputs\.targetSet \}\}'/u)
  for (const name of ['Record installer package sizes', 'Verify beta download Page before publication', 'Re-download and verify the published GitHub assets', 'Verify beta download Page after publication']) {
    assert.ok(workflow.jobs.release.steps.some(step => step.name === name), name)
  }
  const beforePage = workflow.jobs.release.steps.find(step => step.name === 'Verify beta download Page before publication')
  assert.match(beforePage.if, /-beta\./u)
  assert.equal(beforePage.env.CLAWMASTER_DOWNLOAD_PAGE_URL, '${{ vars.CLAWMASTER_DOWNLOAD_PAGE_URL }}')
})

test('publication runs the strict installed-evidence gate before manifest generation and release upload', t => {
  const steps = workflow.jobs.release.steps
  const gateIndex = steps.findIndex(step => step.name === 'Require complete installed acceptance evidence')
  assert.ok(gateIndex >= 0)
  const gate = steps[gateIndex]
  assert.equal(gate.shell, 'bash')
  assert.equal(gate.if, undefined)
  assert.notEqual(gate['continue-on-error'], true)
  assert.ok(gateIndex < steps.findIndex(step => step.name === 'Generate updater manifest'))
  assert.ok(gateIndex < steps.findIndex(step => step.run?.includes('gh release create')))
  assert.match(gate.run, /release-acceptance\.mjs/)
  assert.doesNotMatch(gate.run, /--report-only/)
  const root = mkdtempSync(join(tmpdir(), 'ClawMaster publication refusal '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'apps/desktop-tauri/scripts'), { recursive: true })
  writeFileSync(join(root, 'apps/desktop-tauri/scripts/release-acceptance.mjs'), readFileSync(new URL('./release-acceptance.mjs', import.meta.url)))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '-q'])
  git(['-c', 'user.name=Acceptance fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'candidate'])
  git(['tag', 'desktop-v0.2.3'])
  const run = () => spawnSync('bash', ['-c', `${gate.run}\ntouch publication-reached`], { cwd: root, env: { ...process.env, RELEASE_TAG: 'desktop-v0.2.3' }, encoding: 'utf8', timeout: 10000 })
  assert.notEqual(run().status, 0, 'Missing evidence must block publication')
  assert.equal(existsSync(join(root, 'publication-reached')), false)
  mkdirSync(join(root, 'release-assets'))
  const manifest = { schemaVersion: 1, version: '0.2.3', sourceCommit: git(['rev-parse', 'HEAD']), supportedUpgradeVersions: ['0.2.2'],
    targets: Object.fromEntries(['macos-arm64-dmg', 'windows-x64-nsis', 'linux-x64-appimage', 'linux-x64-deb'].map(target => [target, { status: 'not-run', reason: 'No installed acceptance evidence' }])) }
  writeFileSync(join(root, 'release-assets/acceptance-manifest.json'), JSON.stringify(manifest))
  const result = run()
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Release acceptance is incomplete/)
  assert.equal(existsSync(join(root, 'publication-reached')), false)
})

test('publication verifies the final asset bytes and provenance before upload', () => {
  const steps = workflow.jobs.release.steps
  const verifierIndex = steps.findIndex(step => step.name === 'Verify immutable release assets and provenance')
  const checksumIndex = steps.findIndex(step => step.name === 'Record release checksums')
  const publishIndex = steps.findIndex(step => step.run?.includes('gh release create'))
  assert.ok(verifierIndex > checksumIndex)
  assert.ok(verifierIndex < publishIndex)
  assert.match(steps[verifierIndex].run, /verify-release-assets\.mjs/)
  assert.match(steps[verifierIndex].run, /rev-parse.*\^\{tree\}/)
  const remote = steps.findIndex(step => step.name === 'Re-download and verify the published GitHub assets')
  assert.ok(remote > publishIndex)
  assert.match(steps[remote].run, /gh release download/u)
  assert.match(steps[remote].run, /verify-release-assets\.mjs/u)
})

test('every shipped frontend has frozen build dependencies before product verification', () => {
  const step = workflow.jobs.build.steps.find(entry => entry.name === 'Install product frontend build dependencies')
  for (const name of ['dsh', 'notes', 'office', 'guard', 'graph-memory', 'rpa', 'updates']) {
    assert.ok(step.run.includes(`npm ci --prefix frontends/${name} --ignore-scripts`), name)
  }
  const bundle = workflow.jobs.build.steps.find(entry => entry.name === 'Build desktop bundles')
  assert.equal(bundle.env.TAURI_SIGNING_PRIVATE_KEY, '${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}')
  assert.ok(workflow.jobs.build.steps.some(entry => entry.name === 'Verify installed Windows desktop and normal relaunch'))
  assert.ok(workflow.jobs.build.steps.some(entry => entry.name === 'Verify macOS acceptance prerequisites' && entry.run.includes('--preflight')))
  const mac = workflow.jobs.build.steps.find(entry => entry.name === 'Verify installed macOS desktop and normal relaunch')
  assert.ok(mac.run.includes('verify-macos-native.mjs'))
  assert.ok(!mac.run.includes('--close-mode terminate'))
})

test('release builds verify publisher signatures while keeping the reset exception version-scoped', () => {
  const steps = workflow.jobs.build.steps
  const windowsSetup = steps.findIndex(step => step.name === 'Prepare Windows publisher certificate')
  const buildIndex = steps.findIndex(step => step.name === 'Build desktop bundles')
  const macVerify = steps.findIndex(step => step.name === 'Verify macOS Developer ID signature and notarization')
  const windowsVerify = steps.findIndex(step => step.name === 'Verify Windows Authenticode signatures')
  assert.ok(windowsSetup >= 0 && windowsSetup < buildIndex)
  assert.ok(macVerify > buildIndex && windowsVerify > buildIndex)
  assert.equal(steps[windowsSetup].env.WINDOWS_SIGNING_PFX, '${{ secrets.WINDOWS_SIGNING_PFX }}')
  assert.equal(steps[windowsSetup].if, "runner.os == 'Windows' && env.RELEASE_TAG != 'desktop-v0.0.1'")
  assert.equal(steps[windowsSetup].env.WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT, '${{ vars.WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT }}')
  assert.match(steps[buildIndex].env.APPLE_SIGNING_IDENTITY, /env\.RELEASE_TAG == 'desktop-v0\.0\.1' && '-'/u)
  assert.match(steps[buildIndex].env.APPLE_CERTIFICATE, /env\.RELEASE_TAG == 'desktop-v0\.0\.1' && ''/u)
  assert.match(steps[buildIndex].env.APPLE_API_KEY_CONTENT, /env\.RELEASE_TAG == 'desktop-v0\.0\.1' && ''/u)
  assert.match(steps[buildIndex].env.WINDOWS_SIGNING_PFX, /env\.RELEASE_TAG == 'desktop-v0\.0\.1' && ''/u)
  assert.match(steps[buildIndex].env.WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT, /env\.RELEASE_TAG == 'desktop-v0\.0\.1' && ''/u)
  assert.match(steps[buildIndex].run, /prepare-macos-signing\.mjs/u)
  assert.match(steps[buildIndex].run, /CLAWMASTER_WINDOWS_SIGNED=false/u)
  assert.match(steps[buildIndex].run, /Remove-Item "Env:\$name"/u)
  assert.match(steps[buildIndex].run, /if \(\$env:APPLE_SIGNING_IDENTITY -eq '-'\)/u)
  assert.match(steps[buildIndex].run, /CLAWMASTER_WINDOWS_SIGNING_CONFIG/u)
  assert.match(steps[macVerify].run, /codesign --verify --deep --strict/u)
  assert.match(steps[macVerify].run, /xcrun stapler validate/u)
  assert.match(steps[windowsVerify].run, /Get-AuthenticodeSignature/u)
  assert.equal(steps[macVerify].if, "runner.os == 'macOS' && env.RELEASE_TAG != 'desktop-v0.0.1'")
  assert.ok(steps[windowsVerify].run.indexOf("if ($env:CLAWMASTER_WINDOWS_SIGNED -ne 'true')") < steps[windowsVerify].run.indexOf('Get-AuthenticodeSignature'))
  const acceptance = workflow.jobs.release.steps.find(step => step.name === 'Require complete installed acceptance evidence')
  assert.match(acceptance.run, /release-acceptance\.mjs/u)
  assert.doesNotMatch(acceptance.run, /--report-only/u)
})

test('platform signing helpers record the reset-only unsigned exception and retain signed setup', () => {
  const mac = readFileSync(new URL('./prepare-macos-signing.mjs', import.meta.url), 'utf8')
  const windows = readFileSync(new URL('./prepare-windows-signing.ps1', import.meta.url), 'utf8')
  assert.match(mac, /only reset 0\.0\.1 acceptance permits/u)
  assert.match(windows, /only reset 0\.0\.1 acceptance permits/u)
  assert.match(windows, /Import-PfxCertificate/u)
  assert.match(windows, /certificateThumbprint/u)
})

test('WeChat approval and updater target replays run on Unix after their built runtime and before packaging', () => {
  const steps = workflow.jobs.build.steps
  const replay = steps.findIndex(step => step.name === 'Replay WeChat approvals and unavailable update targets')
  assert.ok(replay > steps.findIndex(step => step.name === 'Build ClawMaster harness'))
  assert.ok(replay > steps.findIndex(step => step.name === 'Build complete Linux sandbox binaries'))
  assert.ok(replay < steps.findIndex(step => step.name === 'Build desktop bundles'))
  assert.equal(steps[replay].if, "runner.os == 'macOS' || runner.os == 'Linux'")
  assert.equal(steps[replay].run, "pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/acp/acp.snapshot.ts -t 'snapshot: (wechat-read-(approved|rejected)|updater-intel-unavailable) matches|snapshot fixtures'")
})

function windowsSteps() {
  const unixOnly = new Set([
    "runner.os == 'Linux'", "runner.os == 'macOS'", "runner.os == 'macOS' || runner.os == 'Linux'",
    "runner.os == 'macOS' && env.RELEASE_TAG != 'desktop-v0.0.1'",
  ])
  return workflow.jobs.build.steps.filter(step => step.run && !unixOnly.has(step.if))
}

test('every Windows build command uses PowerShell with native failures enabled before execution', () => {
  assert.equal(workflow.jobs.build.defaults.run.shell, 'pwsh')
  for (const step of windowsSteps()) {
    assert.equal(step.shell ?? workflow.jobs.build.defaults.run.shell, 'pwsh', step.name)
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps.filter(entry => entry.run && (entry.shell ?? job.defaults?.run?.shell) === 'pwsh')) {
      assert.match(step.run, /^\$ErrorActionPreference = 'Stop'\nif \(\$PSVersionTable\.PSVersion -lt \[version\]'7\.4'\) \{ throw 'PowerShell 7\.4 or later is required' \}\n\$PSNativeCommandUseErrorActionPreference = \$true\n/, step.name)
    }
  }
  const version = windowsSteps().find(step => step.name === 'Validate release version')
  assert.match(version.run, /release-channel\.mjs \$env:RELEASE_TAG/)
})

/** Every step the workflow runs under PowerShell, whichever runner it selects. */
function powershellSteps() {
  const found = []
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.run && (step.shell ?? job.defaults?.run?.shell) === 'pwsh') found.push(step)
    }
  }
  return found
}

/** Braces outside quoted literals; PowerShell refuses to run a script whose count is not zero. */
function braceBalance(script) {
  const bare = script.replace(/'[^'\n]*'/gu, "''").replace(/"[^"\n]*"/gu, '""')
  return (bare.match(/\{/gu) ?? []).length - (bare.match(/\}/gu) ?? []).length
}

test('the version sources and the published tag history are checked before any platform build', () => {
  const steps = workflow.jobs.build.steps
  const validateIndex = steps.findIndex(step => step.name === 'Validate release version')
  const commands = steps[validateIndex].run.split('\n').map(line => line.trim())
  const wanted = [
    'node apps/desktop-tauri/scripts/desktop-version.mjs --check',
    'node apps/desktop-tauri/scripts/release-channel.mjs $env:RELEASE_TAG',
    'node apps/desktop-tauri/scripts/release-version-guard.mjs --check $env:RELEASE_TAG',
  ]
  const positions = wanted.map(command => commands.indexOf(command))
  for (const [index, position] of positions.entries()) assert.ok(position >= 0, wanted[index])
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right))
  assert.ok(validateIndex < steps.findIndex(step => step.name === 'Build desktop bundles'))
  assert.ok(validateIndex < steps.findIndex(step => step.name === 'Stage release assets'))
})

test('every PowerShell step is a complete script', () => {
  const scripts = powershellSteps()
  assert.ok(scripts.length > 0)
  for (const step of scripts) assert.equal(braceBalance(step.run), 0, step.name)
  const staged = scripts.find(step => step.name === 'Stage release assets')
  assert.notEqual(braceBalance(`${staged.run}\n}`), 0, 'a stray closing brace must be rejected')
})

const pwsh = process.env.CLAWMASTER_TEST_PWSH || 'pwsh'
const probe = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8', timeout: 10000,
})
const pwshAvailable = !probe.error && probe.status === 0

test('PowerShell is required for workflow regression checks on CI', { skip: !process.env.CI && !process.env.CLAWMASTER_TEST_PWSH }, () => {
  assert.equal(probe.error, undefined)
  assert.equal(probe.signal, null)
  assert.equal(probe.status, 0, probe.stderr)
  const [major, minor] = probe.stdout.trim().split('.').map(Number)
  assert.ok(major > 7 || (major === 7 && minor >= 4), probe.stdout)
})

test('real workflow command sequences stop at the failing native call and retain the negative control', {
  skip: pwshAvailable ? false : 'PowerShell is unavailable; CI requires it',
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'ClawMaster workflow 验收 # '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixture = join(root, 'native-call.cjs')
  writeFileSync(fixture, `const fs = require('node:fs');
const path = process.env.CLAWMASTER_TEST_TRACE;
const calls = fs.readFileSync(path, 'utf8').trim().split('\\n').filter(Boolean);
fs.appendFileSync(path, JSON.stringify(process.argv.slice(2)) + '\\n');
if (calls.length === Number(process.env.CLAWMASTER_TEST_FAIL_AT)) process.exit(23);
`)
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|HOME|USERPROFILE|TEMP|TMP|TMPDIR)$/i.test(key)) env[key] = value
  }
  env.CLAWMASTER_TEST_NODE = process.execPath
  env.CLAWMASTER_TEST_FIXTURE = fixture
  const wrappers = ['node', 'npm', 'pnpm'].map(name =>
    `function ${name} { & $env:CLAWMASTER_TEST_NODE $env:CLAWMASTER_TEST_FIXTURE '${name}' @args }`).join('\n')
  const epilogue = "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n"
  for (const name of ['Build ClawMaster harness', 'Verify Graph Memory component', 'Prepare verified Office editor resources']) {
    const step = windowsSteps().find(entry => entry.name === name)
    const commands = step.run.split('\n').filter(line => /^(node|npm|pnpm) /.test(line))
    assert.ok(commands.length > 1, name)
    for (const enabled of [false, true]) {
      for (let failure = 0; failure < commands.length - 1; failure++) {
        const trace = join(root, 'calls.jsonl'), script = join(root, 'step.ps1')
        writeFileSync(trace, '')
        const body = enabled ? step.run : step.run.replace('$PSNativeCommandUseErrorActionPreference = $true', '$PSNativeCommandUseErrorActionPreference = $false')
        writeFileSync(script, `${wrappers}\n${body}\n${epilogue}`)
        const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
          cwd: root, env: { ...env, CLAWMASTER_TEST_TRACE: trace, CLAWMASTER_TEST_FAIL_AT: String(failure) },
          encoding: 'utf8', timeout: 30000,
        })
        assert.equal(result.error, undefined, `${name}: ${result.error}`)
        assert.equal(result.signal, null, name)
        const calls = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        assert.deepEqual(calls.map(args => args.join(' ')), commands.slice(0, enabled ? failure + 1 : commands.length), name)
        if (enabled) {
          assert.notEqual(result.status, 0, name)
          assert.match(result.stderr, /23/, name)
        } else {
          assert.equal(result.status, 0, `${name}: ${result.stderr}`)
        }
      }
    }
  }
})

test('PowerShell parses every workflow script a runner will execute', {
  skip: pwshAvailable ? false : 'PowerShell is unavailable; CI requires it',
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'ClawMaster workflow parse '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const wrapper = join(root, 'parse.ps1')
  writeFileSync(wrapper, '[scriptblock]::Create((Get-Content -Raw -LiteralPath $args[0])) | Out-Null\n')
  for (const step of powershellSteps()) {
    const script = join(root, 'step.ps1')
    writeFileSync(script, step.run)
    const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper, script], {
      cwd: root, encoding: 'utf8', timeout: 30000,
    })
    assert.equal(result.error, undefined, `${step.name}: ${result.error}`)
    assert.equal(result.status, 0, `${step.name}: ${result.stderr}`)
  }
})
