import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ACCEPTANCE_TARGETS, acceptanceTargetsForVersion, createAcceptanceTemplate, verifyReleaseAcceptance } from './release-acceptance.mjs'

const commit = 'a'.repeat(40)
const version = '0.2.3'
const hash = value => createHash('sha256').update(value).digest('hex')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-release-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'logs'))
  const log = 'Synthetic validator fixture; this file is not platform acceptance evidence.\n'
  await writeFile(join(root, 'logs/scenarios.txt'), log)
  const evidence = [{ file: 'logs/scenarios.txt', sha256: hash(log) }]
  const passed = () => ({ status: 'passed', evidence: structuredClone(evidence) })
  const targets = {}
  for (const [name, policy] of Object.entries(ACCEPTANCE_TARGETS)) {
    const file = `${name}${policy.extension}`
    await writeFile(join(root, file), `synthetic ${name}`)
    targets[name] = {
      status: 'passed', platform: policy.platform, architecture: policy.architecture, osVersion: 'fixture OS', environment: 'clean-vm',
      installedVersion: version, sourceCommit: commit, artifact: { file, sha256: hash(`synthetic ${name}`) },
      signature: { ...passed(), kind: policy.signature, publisher: 'Fixture Publisher' },
      scenarios: Object.fromEntries(['install', 'first-start-clean-user', 'network-failure-recovery', 'exit-restart',
        'uninstall-data-policy', 'unicode-space-path', 'update-rollback', 'optional-component-failure-recovery', 'approval-allow', 'approval-deny', 'cancel-task', 'write-failure-no-commit',
        'conversation-persistence'].map(key => [key, passed()])),
      upgrades: { '0.2.2': { ...passed(), preserved: { settings: true, credentials: true, sessions: true, businessData: true } } },
      integrations: { 'real-model': { ...passed(), availability: 'available', credentialStore: {
        darwin: 'macos-keychain', win32: 'windows-credential-manager', linux: 'linux-secret-service', android: 'android-keystore',
      }[policy.platform] }, 'office-save': { ...passed(), availability: 'available' },
        'wechat-selected-read': { status: 'not-run', availability: 'experimental', reason: 'No authorized test account' },
        'native-rpa-browser-click': { ...passed(), availability: 'available', browserVersion: 'Fixture Browser 1' },
        ...Object.fromEntries(['weixin', 'feishu', 'dingtalk', 'qq', 'wecom'].map(channel => [`im-${channel}-ui`, {
          ...passed(), availability: 'unavailable', uiState: 'blocked', reason: 'No configured connector',
        }])) },
    }
  }
  return { root, manifest: { schemaVersion: 1, version, sourceCommit: commit, supportedUpgradeVersions: ['0.2.2'], targets },
    options: { root, expectedCommit: commit, expectedVersion: version } }
}

function resetCandidate(f) {
  f.manifest.version = '0.0.1'
  f.options.expectedVersion = '0.0.1'
  f.manifest.supportedUpgradeVersions = []
  for (const [target, kind, reason] of [
    ['macos-arm64-dmg', 'ad-hoc-unnotarized', 'Ad-hoc signed; not notarized or verified by Apple Developer ID.'],
    ['windows-x64-nsis', 'unsigned', 'Unsigned installer; Windows publisher identity is not verified.'],
  ]) {
    const lane = f.manifest.targets[target]
    lane.installedVersion = '0.0.1'
    lane.upgrades = {}
    lane.signature.kind = kind
    lane.signature.reason = reason
    delete lane.signature.publisher
  }
  for (const lane of Object.values(f.manifest.targets)) {
    lane.installedVersion = '0.0.1'
    lane.upgrades = {}
  }
}

test('a complete per-installer matrix validates artifacts and retained evidence', async t => {
  const f = await fixture(t)
  assert.equal((await verifyReleaseAcceptance(f.manifest, f.options)).ready, true)
})

test('missing desktop platforms, Intel substitution and another platform observation cannot count as acceptance', async t => {
  const f = await fixture(t)
  const missing = structuredClone(f.manifest)
  delete missing.targets['linux-x64-appimage']
  await assert.rejects(verifyReleaseAcceptance(missing, f.options), /Every supported installer/)
  const intel = structuredClone(f.manifest)
  intel.targets['macos-x64-dmg'] = intel.targets['macos-arm64-dmg']
  delete intel.targets['macos-arm64-dmg']
  await assert.rejects(verifyReleaseAcceptance(intel, f.options), /Intel Mac/)
  f.manifest.targets['windows-x64-nsis'].platform = 'darwin'
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /cannot borrow/)
})

test('a stale build, modified installer or edited log invalidates acceptance', async t => {
  const f = await fixture(t)
  await assert.rejects(verifyReleaseAcceptance(f.manifest, { ...f.options, expectedCommit: 'b'.repeat(40) }), /another source commit/)
  await assert.rejects(verifyReleaseAcceptance(f.manifest, { ...f.options, expectedVersion: '0.2.4' }), /another release version/)
  await writeFile(join(f.root, f.manifest.targets['macos-arm64-dmg'].artifact.file), 'modified bytes')
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /Evidence digest differs/)
  const other = await fixture(t)
  await writeFile(join(other.root, 'logs/scenarios.txt'), 'edited evidence')
  await assert.rejects(verifyReleaseAcceptance(other.manifest, other.options), /Evidence digest differs/)
})

test('ad-hoc or updater signatures cannot replace publisher notarization and Authenticode', async t => {
  const f = await fixture(t)
  f.manifest.targets['macos-arm64-dmg'].signature.kind = 'ad-hoc'
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /publisher verification/)
  f.manifest.targets['macos-arm64-dmg'].signature.kind = 'developer-id-notarized'
  f.manifest.targets['windows-x64-nsis'].signature.kind = 'minisign'
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /publisher verification/)
})

test('only reset 0.0.1 accepts documented unsigned macOS and Windows builds', async t => {
  const f = await fixture(t)
  resetCandidate(f)
  assert.equal((await verifyReleaseAcceptance(f.manifest, f.options)).ready, true)
  assert.equal(acceptanceTargetsForVersion('0.2.4')['macos-arm64-dmg'].signature, 'developer-id-notarized')
  assert.equal(acceptanceTargetsForVersion('0.2.4')['windows-x64-nsis'].signature, 'authenticode')

  const stable = await fixture(t)
  stable.manifest.targets['macos-arm64-dmg'].signature.kind = 'ad-hoc-unnotarized'
  stable.manifest.targets['macos-arm64-dmg'].signature.reason = 'Not notarized.'
  await assert.rejects(verifyReleaseAcceptance(stable.manifest, stable.options), /publisher verification/)
})

test('missing restart, rollback and old-version retention evidence blocks publication', async t => {
  for (const [target, scenario] of [['macos-arm64-dmg', 'exit-restart'], ['linux-x64-deb', 'update-rollback']]) {
    const f = await fixture(t)
    f.manifest.targets[target].scenarios[scenario] = { status: 'not-run', reason: 'Awaiting device' }
    const observed = await verifyReleaseAcceptance(f.manifest, { ...f.options, requireComplete: false })
    assert.equal(observed.ready, false)
    assert.ok(observed.incomplete.some(item => item.includes(`${target}/${scenario}`)))
    await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /incomplete/)
  }
  const f = await fixture(t)
  f.manifest.targets['windows-x64-nsis'].upgrades['0.2.2'].preserved.credentials = false
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /retain credentials/)
})

test('unverified trial integrations stay explicitly unavailable and real-model verification remains mandatory', async t => {
  const f = await fixture(t)
  f.manifest.targets['macos-arm64-dmg'].integrations['wechat-selected-read'].availability = 'available'
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /advertised available/)
  f.manifest.targets['macos-arm64-dmg'].integrations['wechat-selected-read'].availability = 'experimental'
  f.manifest.targets['linux-x64-appimage'].integrations['real-model'] = { status: 'blocked', availability: 'unavailable', reason: 'No provider test credentials' }
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /successful installed integration/)
})

test('passing account integrations need explicit consent and exact client compatibility evidence', async t => {
  const f = await fixture(t)
  const lane = f.manifest.targets['windows-x64-nsis']
  lane.integrations['wechat-selected-read'] = { ...lane.integrations['real-model'] }
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /test-account consent/)
  lane.integrations['wechat-selected-read'].testAccountConsent = true
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /tested client version/)
})

test('desktop acceptance requires installed approval and no-partial-write scenarios', async t => {
  const f = await fixture(t)
  for (const scenario of ['approval-allow', 'approval-deny', 'cancel-task', 'write-failure-no-commit']) {
    delete f.manifest.targets['windows-x64-nsis'].scenarios[scenario]
  }
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /windows-x64-nsis\/approval-allow/)
})

test('desktop acceptance requires failed optional components to leave core use available', async t => {
  const f = await fixture(t)
  delete f.manifest.targets['macos-arm64-dmg'].scenarios['optional-component-failure-recovery']
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /macos-arm64-dmg\/optional-component-failure-recovery/)
})

test('desktop acceptance requires OS credentials, honest RPA availability, and five honest connector states', async t => {
  const f = await fixture(t)
  const lane = f.manifest.targets['windows-x64-nsis']
  lane.integrations['real-model'].credentialStore = 'plaintext-file'
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /OS secure credential store/)
  lane.integrations['real-model'].credentialStore = 'windows-credential-manager'
  lane.integrations['native-rpa-browser-click'] = {
    ...lane.integrations['real-model'], status: 'blocked', availability: 'unavailable', reason: 'No interactive browser fixture',
  }
  const blocked = await verifyReleaseAcceptance(f.manifest, { ...f.options, requireComplete: false })
  assert.equal(blocked.ready, false)
  assert.ok(blocked.incomplete.some(item => item.includes('native-rpa-browser-click')))
  lane.integrations['native-rpa-browser-click'].status = 'passed'
  lane.integrations['native-rpa-browser-click'].uiState = 'blocked'
  const disabled = await verifyReleaseAcceptance(f.manifest, f.options)
  assert.equal(disabled.ready, true)
  lane.integrations['native-rpa-browser-click'].uiState = undefined
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /must show a blocked state/)
  lane.integrations['native-rpa-browser-click'].availability = 'available'
  lane.integrations['native-rpa-browser-click'].browserVersion = 'Fixture Browser 1'
  lane.integrations['im-qq-ui'].uiState = 'connected'
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /blocked state/)
})

test('beta template contains only the Windows and macOS installer lanes', () => {
  const template = createAcceptanceTemplate('0.2.3-beta.1', commit, ['0.2.2'])
  assert.deepEqual(Object.keys(template.targets).sort(), ['macos-arm64-dmg', 'windows-x64-nsis'])
})

test('the reset 0.0.1 release may require manual reinstall without duplicate upgrade evidence', async t => {
  const f = await fixture(t)
  resetCandidate(f)
  assert.equal((await verifyReleaseAcceptance(f.manifest, f.options)).ready, true)
  assert.deepEqual(createAcceptanceTemplate('0.0.1', commit, []).supportedUpgradeVersions, [])
  assert.throws(() => createAcceptanceTemplate('0.2.4', commit, []), /Only the reset 0\.0\.1 release/)
  const unsupportedLater = structuredClone(f.manifest)
  unsupportedLater.version = '0.2.4'
  await assert.rejects(verifyReleaseAcceptance(unsupportedLater, { ...f.options, expectedVersion: '0.2.4' }), /Only the reset 0\.0\.1 release/)
})

test('an evidence path cannot escape its root or replace a retained file with a symlink', async t => {
  const f = await fixture(t)
  f.manifest.targets['macos-arm64-dmg'].signature.evidence[0].file = '../outside.txt'
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /stay within/)
  if (process.platform !== 'win32') {
    await symlink(join(f.root, 'logs/scenarios.txt'), join(f.root, 'redirected'))
    f.manifest.targets['macos-arm64-dmg'].signature.evidence[0].file = 'redirected'
    await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /symbolic links/)
  }
})

test('the publication CLI fails for blocked certificates while report-only retains honest incomplete results', async t => {
  const f = await fixture(t)
  f.manifest.targets['macos-arm64-dmg'] = { status: 'blocked', reason: 'Developer ID and notarization credentials are unavailable' }
  const path = join(f.root, 'acceptance.json')
  await writeFile(path, JSON.stringify(f.manifest))
  const args = [fileURLToPath(new URL('./release-acceptance.mjs', import.meta.url)), '--manifest', path, '--commit', commit, '--version', version]
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), error => error.status !== 0 && String(error.stderr).includes('Developer ID'))
  const report = JSON.parse(execFileSync(process.execPath, [...args, '--report-only'], { encoding: 'utf8' }))
  assert.equal(report.ready, false)
  assert.equal(report.incomplete.length, 1)
})
