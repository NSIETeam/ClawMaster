/** Verify immutable release files, their checksums and source provenance before publication. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { normalizedAssets } from './generate-updater-manifest.mjs'

const hashPattern = /^[a-f0-9]{64}$/u
const commitPattern = /^[a-f0-9]{40}$/u

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
  const assets = normalizedAssets(version, 'current')
  const names = [...new Set([
    ...Object.values(assets),
    ...Object.values(assets).map(name => `${name}.sig`),
    `clawmaster-${version}-windows-x64-build.json`,
    `clawmaster-${version}-macos-arm64-build.json`,
    `clawmaster-${version}-linux-x64-build.json`,
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

/** @param {object} build @param {string} file @param {string} version @param {string} commit @param {string} tree @returns {void} Validate one public build identity record. */
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
  for (const kind of ['components', 'locks', 'patches']) {
    assert.ok(Array.isArray(inventory?.[kind]) && inventory[kind].length > 0, `${file} has incomplete ${kind} inventory`)
    for (const entry of inventory[kind]) {
      text(entry.path, `${file} inventory path`)
      assert.match(entry.sha256 ?? '', hashPattern, `${file} inventory digest`)
    }
  }
}

/**
 * Verify the release directory after the acceptance gate and checksum generation.
 * @param {{assetsDir:string, version:string, expectedCommit:string, expectedTree:string}} options Release directory and candidate identity.
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
  await verifyChecksums(root)
  const buildFiles = required.filter(name => name.endsWith('-build.json'))
  for (const file of buildFiles) verifyBuildRecord(JSON.parse(await readFile(join(root, file), 'utf8')), file, options.version, options.expectedCommit, options.expectedTree)
  const latest = JSON.parse(await readFile(join(root, 'latest.json'), 'utf8'))
  assert.equal(latest.version, options.version, 'Updater manifest has another version')
  assert.deepEqual(Object.keys(latest.platforms ?? {}).sort(), Object.keys(normalizedAssets(options.version, 'current')).sort(), 'Updater manifest target set differs from the release set')
  return { files: files.sort(), version: options.version, sourceCommit: options.expectedCommit }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { 'assets-dir': { type: 'string' }, version: { type: 'string' }, commit: { type: 'string' }, tree: { type: 'string' } } })
  assert.ok(values['assets-dir'] && values.version && values.commit && values.tree, 'Required: --assets-dir <dir> --version <version> --commit <full SHA> --tree <full tree SHA>')
  const result = await verifyReleaseAssets({ assetsDir: values['assets-dir'], version: values.version, expectedCommit: values.commit, expectedTree: values.tree })
  console.log(`Release assets verified: ${result.files.length} files, source ${result.sourceCommit}`)
}
