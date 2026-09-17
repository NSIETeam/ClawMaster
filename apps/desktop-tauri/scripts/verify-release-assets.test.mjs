import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { requiredReleaseAssetNames, verifyReleaseAssets } from './verify-release-assets.mjs'
import { ACCEPTANCE_TARGETS } from './release-acceptance.mjs'

const version = '0.2.3'
const commit = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const hash = value => createHash('sha256').update(value).digest('hex')
const installers = {
  'macos-arm64-dmg': `clawmaster-${version}-macos-arm64.dmg`,
  'windows-x64-nsis': `clawmaster-${version}-windows-x64-setup.exe`,
  'linux-x64-appimage': `clawmaster-${version}-linux-x64.AppImage`,
  'linux-x64-deb': `clawmaster-${version}-linux-x64.deb`,
  'android-universal-apk': `clawmaster-${version}-android-universal.apk`,
}

async function checksum(root) {
  const files = (await readdir(root)).filter(file => file !== 'SHA256SUMS.txt').sort()
  const sums = []
  for (const file of files) sums.push(`${hash(await readFile(join(root, file)))}  ${file}`)
  await writeFile(join(root, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-release-assets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = [...new Set([...requiredReleaseAssetNames(version), ...Object.values(installers), 'acceptance-evidence.txt'])]
  for (const file of files) {
    let content = `fixture ${file}\n`
    if (file.endsWith('-build.json')) {
      content = JSON.stringify({ desktopVersion: version, contentSha256: 'c'.repeat(64), buildProvenance: {
        schemaVersion: 1, mode: 'release', source: { gitCommit: commit, gitTree: tree, dirty: false, dirtyFiles: [], sourceSha256: 'd'.repeat(64) },
        artifacts: { harness: { fileCount: 1, sha256: 'e'.repeat(64) }, product: { fileCount: 1, sha256: 'f'.repeat(64) } },
        inventory: { components: [{ name: '@clawmaster/dsh', version: '0.2.3', manifest: { path: 'apps/cli/package.json', sha256: '1'.repeat(64) }, artifacts: [{ path: 'apps/cli/lib/index.js', sha256: '4'.repeat(64) }] }], locks: [{ path: 'pnpm-lock.yaml', sha256: '2'.repeat(64) }], patches: [{ path: 'patch.patch', sha256: '3'.repeat(64) }] },
      } })
    }
    if (file === 'latest.json') content = JSON.stringify({ version, platforms: {
      'windows-x86_64': {}, 'darwin-aarch64': {}, 'linux-x86_64': {}, 'linux-x86_64-deb': {},
    } })
    await writeFile(join(root, file), content)
  }
  const evidence = [{ file: 'acceptance-evidence.txt', sha256: hash(await readFile(join(root, 'acceptance-evidence.txt'))) }]
  const passed = () => ({ status: 'passed', evidence: structuredClone(evidence) })
  // Synthetic observations exercise validation and never serve as release evidence.
  const targets = {}
  for (const [target, policy] of Object.entries(ACCEPTANCE_TARGETS)) {
    targets[target] = {
      status: 'passed', platform: policy.platform, architecture: policy.architecture, osVersion: 'fixture OS', environment: 'clean-vm',
      installedVersion: version, sourceCommit: commit, artifact: { file: installers[target], sha256: hash(await readFile(join(root, installers[target]))) },
      signature: { ...passed(), kind: policy.signature, publisher: 'Fixture Publisher' },
      scenarios: Object.fromEntries(['install', 'first-start-clean-user', 'network-failure-recovery', 'exit-restart', 'upgrade-data-preservation',
        'uninstall-data-policy', 'unicode-space-path', 'update-rollback', 'approval-allow', 'approval-deny', 'cancel-task', 'conversation-persistence'].map(key => [key, passed()])),
      upgrades: { '0.2.2': { ...passed(), preserved: { settings: true, credentials: true, sessions: true, businessData: true } } },
      integrations: { 'real-model': { ...passed(), availability: 'available' }, 'office-save': { ...passed(), availability: 'available' },
        'wechat-selected-read': { status: 'not-run', availability: 'experimental', reason: 'No authorized test account' },
        'im-login': { status: 'not-run', availability: 'unavailable', reason: 'No configured test tenant' } },
    }
  }
  const manifest = { schemaVersion: 1, version, sourceCommit: commit, supportedUpgradeVersions: ['0.2.2'], targets }
  await writeFile(join(root, 'acceptance-manifest.json'), JSON.stringify(manifest))
  await checksum(root)
  return { root, manifest, options: { assetsDir: root, version, expectedCommit: commit, expectedTree: tree } }
}

test('verifies the exact current release asset set and public source inventories', async t => {
  const f = await fixture(t)
  const result = await verifyReleaseAssets({ assetsDir: f.root, version, expectedCommit: commit, expectedTree: tree })
  assert.equal(result.version, version)
  assert.deepEqual(result.files, [...requiredReleaseAssetNames(version), 'acceptance-evidence.txt', 'SHA256SUMS.txt'].sort())
})

test('rejects stale checksums, missing assets, Intel artifacts and foreign build records', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'SHA256SUMS.txt'), `${'0'.repeat(64)}  latest.json\n`)
  await assert.rejects(verifyReleaseAssets({ assetsDir: f.root, version, expectedCommit: commit, expectedTree: tree }), /does not cover exactly|checksum differs/)
  const g = await fixture(t)
  await rm(join(g.root, 'clawmaster-0.2.3-windows-x64-setup.exe'))
  await assert.rejects(verifyReleaseAssets({ assetsDir: g.root, version, expectedCommit: commit, expectedTree: tree }), /Missing release asset/)
  const h = await fixture(t)
  await writeFile(join(h.root, 'clawmaster-0.2.3-macos-x64.app.tar.gz'), 'Intel')
  await assert.rejects(verifyReleaseAssets({ assetsDir: h.root, version, expectedCommit: commit, expectedTree: tree }), /Intel Mac asset/)
  const i = await fixture(t)
  const buildPath = join(i.root, `clawmaster-${version}-linux-x64-build.json`)
  const build = JSON.parse(await readFile(buildPath, 'utf8'))
  build.buildProvenance.source.gitTree = '9'.repeat(40)
  await writeFile(buildPath, JSON.stringify(build))
  await assert.rejects(verifyReleaseAssets({ assetsDir: i.root, version, expectedCommit: commit, expectedTree: tree }), /another source tree|checksum differs/)
})

test('requires a complete public component inventory', async t => {
  const f = await fixture(t)
  const path = join(f.root, `clawmaster-${version}-windows-x64-build.json`)
  const build = JSON.parse(await readFile(path, 'utf8'))
  build.buildProvenance.inventory.locks = []
  await writeFile(path, JSON.stringify(build))
  await checksum(f.root)
  await assert.rejects(verifyReleaseAssets({ assetsDir: f.root, version, expectedCommit: commit, expectedTree: tree }), /incomplete locks inventory/)
})

test('a checksummed release still requires the candidate DMG and Android installer', async t => {
  for (const target of ['macos-arm64-dmg', 'android-universal-apk']) {
    const f = await fixture(t)
    await rm(join(f.root, installers[target]))
    await writeFile(join(f.root, installers[target].replace(version, '0.2.2')), 'old installer')
    await checksum(f.root)
    await assert.rejects(verifyReleaseAssets(f.options), /Missing release asset/)
  }
})

test('the final verifier rejects incomplete or foreign acceptance even after checksums are regenerated', async t => {
  for (const change of [
    manifest => { manifest.targets['windows-x64-nsis'] = { status: 'blocked', reason: 'Publisher certificate unavailable' } },
    manifest => { manifest.sourceCommit = '9'.repeat(40) },
  ]) {
    const f = await fixture(t)
    change(f.manifest)
    await writeFile(join(f.root, 'acceptance-manifest.json'), JSON.stringify(f.manifest))
    await checksum(f.root)
    await assert.rejects(verifyReleaseAssets(f.options), /acceptance is incomplete|another source commit/)
  }
})

test('installed acceptance must describe the exact installer offered in the release', async t => {
  const f = await fixture(t)
  const installer = f.manifest.targets['windows-x64-nsis'].artifact
  await writeFile(join(f.root, 'accepted-but-not-published.exe'), await readFile(join(f.root, installer.file)))
  installer.file = 'accepted-but-not-published.exe'
  await writeFile(join(f.root, 'acceptance-manifest.json'), JSON.stringify(f.manifest))
  await checksum(f.root)
  await assert.rejects(verifyReleaseAssets(f.options), /installer differs from the published asset/)
})

test('regenerated release checksums cannot certify an installer changed after installed acceptance', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, installers['windows-x64-nsis']), 'different installer bytes')
  await checksum(f.root)
  await assert.rejects(verifyReleaseAssets(f.options), /Evidence digest differs/)
})
