/** Verify immutable release files, their checksums and source provenance before publication. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { readdir, readFile, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { normalizedAssets } from './generate-updater-manifest.mjs'
import { acceptanceTargetsForVersion, verifyReleaseAcceptance } from './release-acceptance.mjs'
import { PACKAGE_OPTIMIZATION_TARGET_BYTES } from './package-size-report.mjs'

const hashPattern = /^[a-f0-9]{64}$/u
const commitPattern = /^[a-f0-9]{40}$/u

/** @param {string} version @returns {Record<string,string>} Installed acceptance lanes bound to the public installer filenames. */
function targetSetForVersion(version) {
  return /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/u.test(version) ? 'beta' : 'current'
}

export function installerAssetsForVersion(version) {
  const assets = normalizedAssets(version, targetSetForVersion(version))
  const result = {}
  for (const target of Object.keys(acceptanceTargetsForVersion(version))) {
    if (target === 'macos-arm64-dmg') result[target] = `clawmaster-${version}-macos-arm64.dmg`
    else if (target === 'windows-x64-nsis') result[target] = assets['windows-x86_64']
    else if (target === 'linux-x64-appimage') result[target] = assets['linux-x86_64']
    else if (target === 'linux-x64-deb') result[target] = assets['linux-x86_64-deb']
    else if (target === 'android-universal-apk') result[target] = `clawmaster-${version}-android-universal.apk`
  }
  return result
}

/** @param {string} path @returns {Promise<string>} The SHA-256 digest of one regular file. */
async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

/** @param {string} value @param {string} label @returns {string} A nonempty field. */
function text(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(value.length > 0, `${label} must not be empty`)
  return value
}

/** @param {string} version @returns {string[]} Names required in the current desktop release set. */
export function requiredReleaseAssetNames(version) {
  const targetSet = targetSetForVersion(version)
  const assets = normalizedAssets(version, targetSet)
  const buildPlatforms = targetSet === 'beta' ? ['windows-x64', 'macos-arm64'] : ['windows-x64', 'macos-arm64', 'linux-x64']
  const names = [...new Set([
    ...Object.values(assets),
    ...Object.values(assets).map(name => `${name}.sig`),
    ...Object.values(installerAssetsForVersion(version)),
    ...buildPlatforms.map(platform => `clawmaster-${version}-${platform}-build.json`),
    'macos-arm64-native-acceptance.json',
    'windows-native-acceptance.json',
    'package-size-report.json',
    'latest.json',
    'clawmaster-release-signing.pub',
    'acceptance-manifest.json',
  ])]
  return names.sort()
}

/** @param {string} line @returns {{sha256:string,file:string}} One GNU checksum record. */
function parseChecksumLine(line) {
  const match = /^(?<sha>[a-f0-9]{64}) {2}(?<file>[^\0\r\n]+)$/u.exec(line)
  assert.ok(match?.groups, 'SHA256SUMS.txt contains an invalid record')
  const file = match.groups.file
  assert.ok(!file.includes('/') && !file.includes('\\') && file !== '.' && file !== '..', 'Checksum paths must be asset basenames')
  return { sha256: match.groups.sha, file }
}

/** @param {string} root @returns {Promise<Map<string,string>>} Checksums for every asset except SHA256SUMS.txt. */
async function verifyChecksums(root) {
  const checksumPath = join(root, 'SHA256SUMS.txt')
  const checksumInfo = await lstat(checksumPath)
  assert.ok(checksumInfo.isFile() && !checksumInfo.isSymbolicLink(), 'SHA256SUMS.txt must be a regular file')
  const lines = (await readFile(checksumPath, 'utf8')).trimEnd().split('\n')
  assert.ok(lines.length > 0 && lines.every(line => line.length > 0), 'SHA256SUMS.txt must contain records')
  const records = lines.map(parseChecksumLine)
  const declared = new Map()
  for (const record of records) assert.equal(declared.has(record.file), false, `Duplicate checksum record: ${record.file}`), declared.set(record.file, record.sha256)
  const entries = await readdir(root, { withFileTypes: true })
  const actual = entries.filter(entry => entry.name !== 'SHA256SUMS.txt')
  for (const entry of actual) assert.ok(entry.isFile() && !entry.isSymbolicLink(), `Release asset must be a regular file: ${entry.name}`)
  assert.deepEqual([...declared.keys()].sort(), actual.map(entry => entry.name).sort(), 'SHA256SUMS.txt does not cover exactly the release files')
  for (const [file, expected] of declared) assert.equal(await sha256File(join(root, file)), expected, `Release checksum differs: ${file}`)
  return declared
}

/** @param {string} path @returns {Promise<Map<string,string>>} Trusted checksum records from a pre-upload snapshot. */
async function readChecksumManifest(path) {
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
  assert.ok(lines.length > 0 && lines.every(line => line.length > 0), 'Trusted checksum manifest must contain records')
  const records = lines.map(parseChecksumLine)
  const result = new Map()
  for (const record of records) assert.equal(result.has(record.file), false, `Duplicate trusted checksum record: ${record.file}`), result.set(record.file, record.sha256)
  return result
}

/** @param {object} build @param {string} file @param {string} version @param {string} commit @param {string} tree @returns {string} Validate one public build record and return its complete lockfile digest. */
function verifyBuildRecord(build, file, version, commit, tree) {
  assert.equal(build.desktopVersion, version, `${file} has another desktop version`)
  assert.match(build.contentSha256 ?? '', hashPattern, `${file} has no payload digest`)
  const provenance = build.buildProvenance
  assert.equal(provenance?.schemaVersion, 1, `${file} has an invalid provenance schema`)
  assert.equal(provenance?.mode, 'release', `${file} is not a release build`)
  assert.equal(provenance?.source?.gitCommit, commit, `${file} belongs to another source commit`)
  assert.equal(provenance?.source?.gitTree, tree, `${file} belongs to another source tree`)
  assert.equal(provenance?.source?.dirty, false, `${file} was built from a dirty source tree`)
  assert.deepEqual(provenance.source.dirtyFiles, [], `${file} records source changes`)
  assert.match(provenance.source.sourceSha256 ?? '', hashPattern, `${file} has no source digest`)
  for (const stage of ['harness', 'product']) {
    assert.ok(Number.isSafeInteger(provenance.artifacts?.[stage]?.fileCount) && provenance.artifacts[stage].fileCount > 0,
      `${file} has no ${stage} artifact inventory`)
    assert.match(provenance.artifacts[stage].sha256 ?? '', hashPattern, `${file} has no ${stage} artifact digest`)
  }
  const inventory = provenance.inventory
  assert.ok(Array.isArray(inventory?.components) && inventory.components.length > 0, `${file} has incomplete components inventory`)
  for (const component of inventory.components) {
    text(component.name, `${file} component name`)
    text(component.version, `${file} component version`)
    for (const entry of [component.manifest, ...(Array.isArray(component.artifacts) ? component.artifacts : [])]) {
      text(entry?.path, `${file} component inventory path`)
      assert.match(entry?.sha256 ?? '', hashPattern, `${file} component inventory digest`)
    }
  }
  for (const kind of ['locks', 'patches']) {
    assert.ok(Array.isArray(inventory?.[kind]) && inventory[kind].length > 0, `${file} has incomplete ${kind} inventory`)
    for (const entry of inventory[kind]) {
      text(entry.path, `${file} ${kind} inventory path`)
      assert.match(entry.sha256 ?? '', hashPattern, `${file} ${kind} inventory digest`)
    }
  }
  const lockIdentity = inventory.locks.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path))
  const lockfilesSha256 = createHash('sha256').update(JSON.stringify(lockIdentity)).digest('hex')
  assert.equal(provenance.lockfilesSha256, lockfilesSha256, `${file} lockfile digest differs from its inventory`)
  assert.ok(inventory.locks.some(entry => entry.path === 'pnpm-lock.yaml'), `${file} omits the workspace lockfile`)
  assert.ok(inventory.locks.some(entry => entry.path === 'apps/desktop-tauri/pnpm-desktop-lock.yaml'), `${file} omits the desktop lockfile`)
  return lockfilesSha256
}

async function verifyPackageSizeReport(root, version, commit) {
  const path = join(root, 'package-size-report.json')
  const report = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.version, version)
  assert.equal(report.sourceCommit, commit)
  assert.equal(report.optimizationTargetBytes, PACKAGE_OPTIMIZATION_TARGET_BYTES)
  const expected = installerAssetsForVersion(version)
  assert.ok(Array.isArray(report.installers), 'Installer size report needs an installer list')
  assert.deepEqual(report.installers.map(entry => entry.target).sort(), Object.keys(expected).sort())
  for (const entry of report.installers) {
    assert.equal(entry.file, expected[entry.target], `${entry.target} size report names another installer`)
    const info = await lstat(join(root, entry.file))
    assert.ok(info.isFile() && !info.isSymbolicLink())
    assert.equal(entry.sizeBytes, info.size, `${entry.file} size differs from its measured bytes`)
    assert.equal(entry.withinOptimizationTarget, info.size <= PACKAGE_OPTIMIZATION_TARGET_BYTES)
  }
}

/**
 * Verify final checksums, installed acceptance and source provenance against the exact public installers.
 * @param {{assetsDir:string, version:string, expectedCommit:string, expectedTree:string, expectedChecksumsPath?:string}} options Release directory and candidate identity.
 * @returns {Promise<{files:string[],version:string,sourceCommit:string}>} Verified release identity.
 */
export async function verifyReleaseAssets(options) {
  assert.match(options.expectedCommit, commitPattern, 'Expected candidate commit must be a full SHA')
  assert.match(options.expectedTree, commitPattern, 'Expected candidate tree must be a full SHA')
  text(options.version, 'Release version')
  const root = resolve(options.assetsDir)
  const rootInfo = await lstat(root)
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Release assets root must be a real directory')
  const files = [...(await readdir(root, { withFileTypes: true }))].filter(entry => entry.isFile()).map(entry => entry.name)
  for (const name of files) assert.ok(!name.includes('macos-x64'), `Intel Mac asset is outside the current release set: ${name}`)
  const required = requiredReleaseAssetNames(options.version)
  for (const name of required) assert.ok(files.includes(name), `Missing release asset: ${name}`)
  const observedChecksums = await verifyChecksums(root)
  if (options.expectedChecksumsPath) {
    const expectedChecksums = await readChecksumManifest(options.expectedChecksumsPath)
    assert.deepEqual([...observedChecksums].sort(([a], [b]) => a.localeCompare(b)),
      [...expectedChecksums].sort(([a], [b]) => a.localeCompare(b)),
      'Published assets differ from the verified pre-upload release files')
  }
  const buildFiles = required.filter(name => name.endsWith('-build.json'))
  const lockfileDigests = new Set()
  for (const file of buildFiles) lockfileDigests.add(verifyBuildRecord(JSON.parse(await readFile(join(root, file), 'utf8')), file, options.version, options.expectedCommit, options.expectedTree))
  assert.equal(lockfileDigests.size, 1, 'Platform builds for one release must use identical lockfile bytes')
  const latest = JSON.parse(await readFile(join(root, 'latest.json'), 'utf8'))
  assert.equal(latest.version, options.version, 'Updater manifest has another version')
  assert.deepEqual(Object.keys(latest.platforms ?? {}).sort(), Object.keys(normalizedAssets(options.version, targetSetForVersion(options.version))).sort(), 'Updater manifest target set differs from the release set')
  const acceptancePath = join(root, 'acceptance-manifest.json')
  assert.ok((await lstat(acceptancePath)).size <= 2 * 1024 * 1024, 'Acceptance manifest must be bounded')
  const acceptance = JSON.parse(await readFile(acceptancePath, 'utf8'))
  await verifyReleaseAcceptance(acceptance, { root, expectedCommit: options.expectedCommit, expectedVersion: options.version })
  for (const [target, file] of Object.entries(installerAssetsForVersion(options.version))) {
    assert.equal(acceptance.targets[target].artifact.file, file, `${target} installer differs from the published asset`)
  }
  await verifyPackageSizeReport(root, options.version, options.expectedCommit)
  const nativeReports = [
    { file: 'macos-arm64-native-acceptance.json', target: 'macos-arm64-dmg', platform: 'darwin' },
    { file: 'windows-native-acceptance.json', target: 'windows-x64-nsis', platform: 'win32' },
  ]
  for (const report of nativeReports) {
    const native = JSON.parse(await readFile(join(root, report.file), 'utf8'))
    assert.equal(native.schemaVersion, 1, `${report.file} has an unsupported schema`)
    assert.equal(native.platform, report.platform, `${report.file} belongs to another platform`)
    assert.equal(acceptance.targets[report.target].scenarios['exit-restart'].evidence.some(entry => entry.file === report.file), true,
      `${report.target} exit-restart evidence must cite its original candidate-run native report`)
    const runtime = native.runs?.[0]?.runtime
    assert.equal(runtime?.desktopVersion, options.version, `${report.file} observed another desktop version`)
    assert.equal(runtime?.buildProvenance?.source?.gitCommit, options.expectedCommit, `${report.file} observed another source commit`)
    assert.equal(runtime?.buildProvenance?.source?.gitTree, options.expectedTree, `${report.file} observed another source tree`)
    if (report.platform === 'darwin') {
      assert.equal(native.closeMode, 'gui', 'macOS evidence must use normal GUI close')
      assert.equal(native.runtimeVerified, true)
      assert.equal(native.guiCloseVerified, true, 'macOS normal GUI close was not verified')
      assert.equal(native.windowGeometryVerified, true)
    } else {
      assert.equal(native.verified, true)
      assert.equal(native.installedProductVersion, options.version)
    }
  }
  return { files: files.sort(), version: options.version, sourceCommit: options.expectedCommit, targetSet: targetSetForVersion(options.version) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const { values } = parseArgs({ options: { 'assets-dir': { type: 'string' }, version: { type: 'string' }, commit: { type: 'string' }, tree: { type: 'string' }, 'expected-checksums': { type: 'string' } } })
  assert.ok(values['assets-dir'] && values.version && values.commit && values.tree, 'Required: --assets-dir <dir> --version <version> --commit <full SHA> --tree <full tree SHA>')
  const result = await verifyReleaseAssets({ assetsDir: values['assets-dir'], version: values.version, expectedCommit: values.commit, expectedTree: values.tree,
    ...(values['expected-checksums'] ? { expectedChecksumsPath: values['expected-checksums'] } : {}) })
  console.log(`Release assets verified: ${result.files.length} files, source ${result.sourceCommit}`)
}
