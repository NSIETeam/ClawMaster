import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { requiredReleaseAssetNames, verifyReleaseAssets } from './verify-release-assets.mjs'

const version = '0.2.3'
const commit = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const hash = value => createHash('sha256').update(value).digest('hex')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-release-assets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = requiredReleaseAssetNames(version)
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
  const sums = []
  for (const file of files) sums.push(`${hash(await readFile(join(root, file)))}  ${file}`)
  await writeFile(join(root, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
  return { root }
}

test('verifies the exact current release asset set and public source inventories', async t => {
  const f = await fixture(t)
  const result = await verifyReleaseAssets({ assetsDir: f.root, version, expectedCommit: commit, expectedTree: tree })
  assert.equal(result.version, version)
  assert.deepEqual(result.files, [...requiredReleaseAssetNames(version), 'SHA256SUMS.txt'].sort())
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
  const sums = []
  for (const file of requiredReleaseAssetNames(version)) sums.push(`${hash(await readFile(join(f.root, file)))}  ${file}`)
  await writeFile(join(f.root, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
  await assert.rejects(verifyReleaseAssets({ assetsDir: f.root, version, expectedCommit: commit, expectedTree: tree }), /incomplete locks inventory/)
})
