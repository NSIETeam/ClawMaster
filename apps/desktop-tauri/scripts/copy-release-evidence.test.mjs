import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyReleaseEvidence } from './copy-release-evidence.mjs'

/** A scratch parent holding one evidence directory and one asset directory. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const source = join(root, 'evidence')
  const destination = join(root, 'assets')
  mkdirSync(source)
  mkdirSync(destination)
  return { root, source, destination }
}

function evidence(directory, name, text = `${name} bytes\n`) {
  writeFileSync(join(directory, name), text)
}

test('reviewed evidence joins the asset directory without disturbing it', async t => {
  const { source, destination } = fixture(t)
  evidence(source, 'acceptance-manifest.json', '{"lanes":[]}\n')
  evidence(source, 'macos-arm64-dmg.json')
  writeFileSync(join(destination, 'ClawMaster_0.0.1_aarch64.dmg'), 'installer bytes')

  const copied = await copyReleaseEvidence({ source, destination })

  assert.deepEqual(copied, ['acceptance-manifest.json', 'macos-arm64-dmg.json'])
  assert.equal(readFileSync(join(destination, 'acceptance-manifest.json'), 'utf8'), '{"lanes":[]}\n')
  assert.equal(readFileSync(join(destination, 'macos-arm64-dmg.json'), 'utf8'), 'macos-arm64-dmg.json bytes\n')
  assert.equal(readFileSync(join(destination, 'ClawMaster_0.0.1_aarch64.dmg'), 'utf8'), 'installer bytes', 'an existing build asset keeps its bytes')
  assert.ok(readFileSync(join(source, 'macos-arm64-dmg.json')).length > 0, 'evidence stays in place as well as being copied')
})

test('a source that is not a real directory is refused', async t => {
  const { root, destination } = fixture(t)
  const file = join(root, 'evidence.json')
  writeFileSync(file, '{}\n')
  await assert.rejects(copyReleaseEvidence({ source: file, destination }), /must be a real directory/)

  const linked = join(root, 'linked-evidence')
  mkdirSync(linked)
  evidence(linked, 'acceptance-manifest.json')
  const alias = join(root, 'evidence-alias')
  symlinkSync(linked, alias)
  await assert.rejects(copyReleaseEvidence({ source: alias, destination }), /must be a real directory/)
})

test('an empty evidence directory is refused', async t => {
  const { source, destination } = fixture(t)
  await assert.rejects(copyReleaseEvidence({ source, destination }), /directory is empty/)
})

test('a symlinked entry is refused because evidence is regular files only', async t => {
  const { root, source, destination } = fixture(t)
  evidence(source, 'acceptance-manifest.json')
  const target = join(root, 'outside.json')
  writeFileSync(target, '{}\n')
  symlinkSync(target, join(source, 'linked-lane.json'))
  await assert.rejects(copyReleaseEvidence({ source, destination }), /regular files only: linked-lane\.json/)
})

test('release checksums are refused because they are generated after evidence is added', async t => {
  const { source, destination } = fixture(t)
  evidence(source, 'acceptance-manifest.json')
  evidence(source, 'SHA256SUMS.txt')
  await assert.rejects(copyReleaseEvidence({ source, destination }), /checksums are generated after evidence is added/)
})

test('evidence cannot replace an original build asset', async t => {
  const { source, destination } = fixture(t)
  evidence(source, 'acceptance-manifest.json')
  evidence(source, 'macos-arm64-dmg.json', 'reviewed\n')
  writeFileSync(join(destination, 'macos-arm64-dmg.json'), 'original build asset\n')

  await assert.rejects(copyReleaseEvidence({ source, destination }), /cannot replace an original build asset: macos-arm64-dmg\.json/)
  assert.equal(readFileSync(join(destination, 'macos-arm64-dmg.json'), 'utf8'), 'original build asset\n', 'the refused run leaves the original untouched')
})

test('evidence without the acceptance manifest is refused', async t => {
  const { source, destination } = fixture(t)
  evidence(source, 'macos-arm64-dmg.json')
  await assert.rejects(copyReleaseEvidence({ source, destination }), /must include acceptance-manifest\.json/)
})

test('a directory entry inside the evidence set is refused', async t => {
  const { source, destination } = fixture(t)
  evidence(source, 'acceptance-manifest.json')
  mkdirSync(join(source, 'nested'))
  await assert.rejects(copyReleaseEvidence({ source, destination }), /regular files only: nested/)
})

test('an unreadable evidence path fails loudly rather than copying nothing', async t => {
  const { root, destination } = fixture(t)
  await assert.rejects(copyReleaseEvidence({ source: join(root, 'absent'), destination }), { code: 'ENOENT' })
  await writeFile(join(root, 'marker'), 'x')
})
