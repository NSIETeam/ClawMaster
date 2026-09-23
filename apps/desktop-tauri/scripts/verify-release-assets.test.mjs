import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { requiredReleaseAssetNames, verifyReleaseAssets } from './verify-release-assets.mjs'
import { acceptanceTargetsForVersion } from './release-acceptance.mjs'
import { normalizedAssets } from './generate-updater-manifest.mjs'
import { PACKAGE_OPTIMIZATION_TARGET_BYTES } from './package-size-report.mjs'

const version = '0.2.3'
const commit = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const hash = value => createHash('sha256').update(value).digest('hex')
function installersFor(releaseVersion) {
  const beta = /-beta\.[1-9]\d*$/u.test(releaseVersion)
  const updater = normalizedAssets(releaseVersion, beta ? 'beta' : 'current')
  const result = {}
  for (const target of Object.keys(acceptanceTargetsForVersion(releaseVersion))) {
    if (target === 'macos-arm64-dmg') result[target] = `clawmaster-${releaseVersion}-macos-arm64.dmg`
    else if (target === 'windows-x64-nsis') result[target] = updater['windows-x86_64']
    else if (target === 'linux-x64-appimage') result[target] = updater['linux-x86_64']
    else if (target === 'linux-x64-deb') result[target] = updater['linux-x86_64-deb']
    else if (target === 'android-universal-apk') result[target] = `clawmaster-${releaseVersion}-android-universal.apk`
  }
  return result
}

async function checksum(root) {
  const files = (await readdir(root)).filter(file => file !== 'SHA256SUMS.txt').sort()
  const sums = []
  for (const file of files) sums.push(`${hash(await readFile(join(root, file)))}  ${file}`)
  await writeFile(join(root, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
}

async function fixture(t, releaseVersion = version) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-release-assets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const installers = installersFor(releaseVersion)
  const files = [...new Set([...requiredReleaseAssetNames(releaseVersion), ...Object.values(installers), 'acceptance-evidence.txt'])]
  for (const file of files) {
    let content = `fixture ${file}\n`
    if (file.endsWith('-build.json')) {
      const locks = [{ path: 'apps/desktop-tauri/pnpm-desktop-lock.yaml', bytes: 21, sha256: '2'.repeat(64) }, { path: 'pnpm-lock.yaml', bytes: 20, sha256: '1'.repeat(64) }]
      const lockfilesSha256 = hash(JSON.stringify(locks))
      content = JSON.stringify({ desktopVersion: releaseVersion, contentSha256: 'c'.repeat(64), buildProvenance: {
        schemaVersion: 1, mode: 'release', source: { gitCommit: commit, gitTree: tree, dirty: false, dirtyFiles: [], sourceSha256: 'd'.repeat(64) },
        artifacts: { harness: { fileCount: 1, sha256: 'e'.repeat(64) }, product: { fileCount: 1, sha256: 'f'.repeat(64) } },
        inventory: { components: [{ name: '@clawmaster/dsh', version: releaseVersion, manifest: { path: 'apps/cli/package.json', sha256: '4'.repeat(64) }, artifacts: [{ path: 'apps/cli/lib/index.js', sha256: '5'.repeat(64) }] }], locks, patches: [{ path: 'patch.patch', sha256: '3'.repeat(64) }] }, lockfilesSha256,
      } })
    }
    if (file === 'latest.json') content = JSON.stringify({ version: releaseVersion, platforms: Object.fromEntries(Object.keys(normalizedAssets(releaseVersion, /-beta\.[1-9]\d*$/u.test(releaseVersion) ? 'beta' : 'current')).map(platform => [platform, {}])) })
    if (file === 'macos-arm64-native-acceptance.json') content = JSON.stringify({ schemaVersion: 1, platform: 'darwin', closeMode: 'gui', runtimeVerified: true,
      guiCloseVerified: true, windowGeometryVerified: true, runs: [{ runtime: { desktopVersion: releaseVersion, buildProvenance: { source: { gitCommit: commit, gitTree: tree } } } }] })
    if (file === 'windows-native-acceptance.json') content = JSON.stringify({ schemaVersion: 1, platform: 'win32', verified: true, installedProductVersion: releaseVersion,
      runs: [{ runtime: { desktopVersion: releaseVersion, buildProvenance: { source: { gitCommit: commit, gitTree: tree } } } }] })
    await writeFile(join(root, file), content)
  }
  const sizeTargets = Object.entries(installers).map(([target, file]) => ({ target, file, sizeBytes: Buffer.byteLength(`fixture ${file}\n`),
    withinOptimizationTarget: Buffer.byteLength(`fixture ${file}\n`) <= PACKAGE_OPTIMIZATION_TARGET_BYTES }))
  await writeFile(join(root, 'package-size-report.json'), JSON.stringify({ schemaVersion: 1, version: releaseVersion, sourceCommit: commit,
    optimizationTargetBytes: PACKAGE_OPTIMIZATION_TARGET_BYTES, installers: sizeTargets }))
  const evidence = [{ file: 'acceptance-evidence.txt', sha256: hash(await readFile(join(root, 'acceptance-evidence.txt'))) }]
  const passed = () => ({ status: 'passed', evidence: structuredClone(evidence) })
  // Synthetic observations exercise validation and never serve as release evidence.
  const targets = {}
  for (const [target, policy] of Object.entries(acceptanceTargetsForVersion(releaseVersion))) {
    targets[target] = {
      status: 'passed', platform: policy.platform, architecture: policy.architecture, osVersion: 'fixture OS', environment: 'clean-vm',
      installedVersion: releaseVersion, sourceCommit: commit, artifact: { file: installers[target], sha256: hash(await readFile(join(root, installers[target]))) },
      signature: { ...passed(), kind: policy.signature, publisher: 'Fixture Publisher' },
      scenarios: Object.fromEntries(['install', 'first-start-clean-user', 'network-failure-recovery', 'exit-restart', 'upgrade-data-preservation',
        'uninstall-data-policy', 'unicode-space-path', 'update-rollback', 'optional-component-failure-recovery', 'approval-allow', 'approval-deny', 'cancel-task', 'write-failure-no-commit', 'conversation-persistence'].map(key => [key, passed()])),
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
  for (const [target, file] of [['macos-arm64-dmg', 'macos-arm64-native-acceptance.json'], ['windows-x64-nsis', 'windows-native-acceptance.json']]) {
    if (targets[target] === undefined) continue
    targets[target].scenarios['exit-restart'].evidence.push({ file, sha256: hash(await readFile(join(root, file))) })
  }
  const manifest = { schemaVersion: 1, version: releaseVersion, sourceCommit: commit, supportedUpgradeVersions: ['0.2.2'], targets }
  await writeFile(join(root, 'acceptance-manifest.json'), JSON.stringify(manifest))
  await checksum(root)
  return { root, manifest, installers, options: { assetsDir: root, version: releaseVersion, expectedCommit: commit, expectedTree: tree } }
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

test('rejects post-upload assets that differ from the trusted pre-upload checksum snapshot', async t => {
  const f = await fixture(t)
  const trustRoot = await mkdtemp(join(tmpdir(), 'clawmaster-trusted-release-checksums-'))
  t.after(() => rm(trustRoot, { recursive: true, force: true }))
  await mkdir(trustRoot, { recursive: true })
  await writeFile(join(trustRoot, 'SHA256SUMS.txt'), await readFile(join(f.root, 'SHA256SUMS.txt')))
  await writeFile(join(f.root, 'latest.json'), '{"version":"0.2.3","platforms":{}}')
  await checksum(f.root)
  await assert.rejects(verifyReleaseAssets({ ...f.options, expectedChecksumsPath: join(trustRoot, 'SHA256SUMS.txt') }), /differ from the verified pre-upload/u)
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

test('one candidate cannot combine platform records built with different lockfile bytes', async t => {
  const f = await fixture(t)
  const path = join(f.root, `clawmaster-${version}-macos-arm64-build.json`)
  const build = JSON.parse(await readFile(path, 'utf8'))
  build.buildProvenance.inventory.locks[0].sha256 = '9'.repeat(64)
  build.buildProvenance.lockfilesSha256 = hash(JSON.stringify(build.buildProvenance.inventory.locks))
  await writeFile(path, JSON.stringify(build))
  await checksum(f.root)
  await assert.rejects(verifyReleaseAssets(f.options), /identical lockfile bytes/u)
})

test('package sizes over the 20 MiB optimization target are reported but do not block publication', async t => {
  const f = await fixture(t)
  const file = f.installers['windows-x64-nsis']
  const payload = Buffer.alloc(PACKAGE_OPTIMIZATION_TARGET_BYTES + 1)
  await writeFile(join(f.root, file), payload)
  f.manifest.targets['windows-x64-nsis'].artifact.sha256 = hash(payload)
  const reportPath = join(f.root, 'package-size-report.json')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const item = report.installers.find(entry => entry.target === 'windows-x64-nsis')
  item.sizeBytes = payload.length
  item.withinOptimizationTarget = false
  await writeFile(reportPath, JSON.stringify(report))
  await writeFile(join(f.root, 'acceptance-manifest.json'), JSON.stringify(f.manifest))
  await checksum(f.root)
  await assert.doesNotReject(verifyReleaseAssets(f.options))
})

test('a checksummed release still requires the candidate DMG and Android installer', async t => {
  for (const target of ['macos-arm64-dmg', 'android-universal-apk']) {
    const f = await fixture(t)
    await rm(join(f.root, f.installers[target]))
    await writeFile(join(f.root, f.installers[target].replace(version, '0.2.2')), 'old installer')
    await checksum(f.root)
    await assert.rejects(verifyReleaseAssets(f.options), /Missing release asset/)
  }
})

test('beta release assets require only macOS ARM64 acceptance; stable still requires every lane', async t => {
  const betaVersion = '0.2.4-beta.1'
  const beta = await fixture(t, betaVersion)
  const verified = await verifyReleaseAssets(beta.options)
  assert.equal(verified.targetSet, 'beta')
  assert.deepEqual(Object.keys(beta.manifest.targets).sort(), ['macos-arm64-dmg'])
  assert.equal(beta.manifest.targets['android-universal-apk'], undefined)
  assert.equal(beta.manifest.targets['linux-x64-appimage'], undefined)
  assert.equal(beta.manifest.targets['windows-x64-nsis'], undefined)
  const stable = await fixture(t)
  assert.deepEqual(Object.keys(stable.manifest.targets).sort(), Object.keys(acceptanceTargetsForVersion(version)).sort())
  assert.ok(stable.manifest.targets['android-universal-apk'])
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

test('native reports remain bound to the candidate and required close evidence after checksums are regenerated', async t => {
  const f = await fixture(t)
  const reportFile = 'macos-arm64-native-acceptance.json'
  const reportPath = join(f.root, reportFile)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  report.runs[0].runtime.buildProvenance.source.gitTree = '9'.repeat(40)
  report.guiCloseVerified = false
  await writeFile(reportPath, JSON.stringify(report))
  const descriptor = f.manifest.targets['macos-arm64-dmg'].scenarios['exit-restart'].evidence.find(entry => entry.file === reportFile)
  descriptor.sha256 = hash(await readFile(reportPath))
  await writeFile(join(f.root, 'acceptance-manifest.json'), JSON.stringify(f.manifest))
  await checksum(f.root)
  await assert.rejects(verifyReleaseAssets({ assetsDir: f.root, version, expectedCommit: commit, expectedTree: tree }), /another source tree/u)
})

test('native evidence cannot claim a passing restart when normal GUI close failed', async t => {
  const f = await fixture(t)
  const reportFile = 'macos-arm64-native-acceptance.json'
  const reportPath = join(f.root, reportFile)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  report.guiCloseVerified = false
  await writeFile(reportPath, JSON.stringify(report))
  const descriptor = f.manifest.targets['macos-arm64-dmg'].scenarios['exit-restart'].evidence.find(entry => entry.file === reportFile)
  descriptor.sha256 = hash(await readFile(reportPath))
  await writeFile(join(f.root, 'acceptance-manifest.json'), JSON.stringify(f.manifest))
  await checksum(f.root)
  await assert.rejects(verifyReleaseAssets({ assetsDir: f.root, version, expectedCommit: commit, expectedTree: tree }), /normal GUI close/u)
})

test('regenerated release checksums cannot certify an installer changed after installed acceptance', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, f.installers['windows-x64-nsis']), 'different installer bytes')
  await checksum(f.root)
  await assert.rejects(verifyReleaseAssets(f.options), /Evidence digest differs/)
})
