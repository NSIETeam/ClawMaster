import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ACCEPTANCE_TARGETS, verifyReleaseAcceptance } from './release-acceptance.mjs'

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
      scenarios: Object.fromEntries(['install', 'first-start-clean-user', 'network-failure-recovery', 'exit-restart', 'upgrade-data-preservation',
        'uninstall-data-policy', 'unicode-space-path', 'update-rollback', 'approval-allow', 'approval-deny', 'cancel-task', 'conversation-persistence'].map(key => [key, passed()])),
      upgrades: { '0.2.2': { ...passed(), preserved: { settings: true, credentials: true, sessions: true, businessData: true } } },
      integrations: { 'real-model': { ...passed(), availability: 'available' }, 'office-save': { ...passed(), availability: 'available' },
        'wechat-selected-read': { status: 'not-run', availability: 'experimental', reason: 'No authorized test account' },
        'im-login': { status: 'not-run', availability: 'unavailable', reason: 'No configured test tenant' } },
    }
  }
  return { root, manifest: { schemaVersion: 1, version, sourceCommit: commit, supportedUpgradeVersions: ['0.2.2'], targets },
    options: { root, expectedCommit: commit, expectedVersion: version } }
}

test('a complete per-installer matrix validates artifacts and retained evidence', async t => {
  const f = await fixture(t)
  assert.equal((await verifyReleaseAcceptance(f.manifest, f.options)).ready, true)
})

test('missing platforms, Intel substitution and another platform observation cannot count as acceptance', async t => {
  const f = await fixture(t)
  const missing = structuredClone(f.manifest)
  delete missing.targets['android-universal-apk']
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

test('missing restart, rollback, old-version retention and Android approval evidence blocks publication', async t => {
  for (const [target, scenario] of [['macos-arm64-dmg', 'exit-restart'], ['linux-x64-deb', 'update-rollback'], ['android-universal-apk', 'approval-deny']]) {
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
  f.manifest.targets['android-universal-apk'].integrations['real-model'] = { status: 'blocked', availability: 'unavailable', reason: 'No provider test credentials' }
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /real provider integration/)
})

test('passing account integrations need explicit consent and exact client compatibility evidence', async t => {
  const f = await fixture(t)
  const lane = f.manifest.targets['windows-x64-nsis']
  lane.integrations['wechat-selected-read'] = { ...lane.integrations['real-model'] }
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /test-account consent/)
  lane.integrations['wechat-selected-read'].testAccountConsent = true
  await assert.rejects(verifyReleaseAcceptance(f.manifest, f.options), /tested client version/)
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
