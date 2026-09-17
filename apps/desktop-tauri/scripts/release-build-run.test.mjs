import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyReleaseEvidence } from './copy-release-evidence.mjs'
import { verifyReleaseBuildRun } from './verify-release-build-run.mjs'

const candidate = '0123456789abcdef0123456789abcdef01234567'
const validRun = () => ({ id: 456, run_attempt: 2, repository: { full_name: 'NSIETeam/ClawMaster-Desktop' },
  path: '.github/workflows/desktop-release.yml',
  status: 'completed', conclusion: 'success', event: 'push', head_sha: candidate })

test('original build run must be successful, same-repository, same-source, and owned by desktop-release workflow', () => {
  const expected = { runId: 456, commit: candidate, tag: 'desktop-v0.2.3', repository: 'NSIETeam/ClawMaster-Desktop' }
  assert.deepEqual(verifyReleaseBuildRun(validRun(), expected), { runId: 456, attempt: 2, commit: candidate })
  for (const change of [
    { repository: { full_name: 'attacker/fork' } },
    { path: 'NSIETeam/ClawMaster-Desktop/.github/workflows/other.yml@refs/tags/desktop-v0.2.3' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { head_sha: 'abcdef0123456789abcdef0123456789abcdef01' },
    { id: 789 },
    { event: 'pull_request' },
  ]) assert.throws(() => verifyReleaseBuildRun({ ...validRun(), ...change }, expected))
})

test('reviewed evidence copies beside original installers without replacing them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'release evidence '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'reviewed')
  const destination = join(root, 'original-run')
  await mkdir(source)
  await mkdir(destination)
  await writeFile(join(source, 'acceptance-manifest.json'), '{}')
  await writeFile(join(source, 'macos-install.log'), 'reviewed evidence')
  await writeFile(join(destination, 'clawmaster-0.2.3-macos-arm64.dmg'), 'immutable original installer')
  assert.deepEqual(await copyReleaseEvidence({ source, destination }), ['acceptance-manifest.json', 'macos-install.log'])
  await writeFile(join(source, 'clawmaster-0.2.3-macos-arm64.dmg'), 'replacement')
  const conflictSource = join(root, 'conflict-evidence')
  const conflictDestination = join(root, 'conflict-run')
  await mkdir(conflictSource)
  await mkdir(conflictDestination)
  await writeFile(join(conflictSource, 'clawmaster-0.2.3-macos-arm64.dmg'), 'replacement')
  await writeFile(join(conflictDestination, 'clawmaster-0.2.3-macos-arm64.dmg'), 'original installer')
  await assert.rejects(copyReleaseEvidence({ source: conflictSource, destination: conflictDestination }), /cannot replace an original build asset/u)
  assert.equal(await readFile(join(conflictDestination, 'clawmaster-0.2.3-macos-arm64.dmg'), 'utf8'), 'original installer')
})

test('reviewed evidence rejects empty and nested evidence directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'release evidence invalid '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'reviewed')
  const destination = join(root, 'original-run')
  await mkdir(source)
  await mkdir(destination)
  await assert.rejects(copyReleaseEvidence({ source, destination }), /empty/u)
  await mkdir(join(source, 'nested'))
  await assert.rejects(copyReleaseEvidence({ source, destination }), /regular files only/u)
})
