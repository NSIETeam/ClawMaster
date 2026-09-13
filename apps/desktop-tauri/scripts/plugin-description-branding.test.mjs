/** Installed plugin descriptions retain package identity and upstream license metadata. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const root = resolve(process.env.DSH_DESKTOP_SMOKE_ROOT ?? join(desktop, 'bundled/harness'))
const resolver = createRequire(join(root, 'apps/cli/package.json'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Resolve the package owning an entry, including packages without a metadata export. */
async function packageRoot(name) {
  let current = dirname(resolver.resolve(name))
  while (dirname(current) !== current) {
    try {
      if (JSON.parse(await readFile(join(current, 'package.json'), 'utf8')).name === name) return current
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    current = dirname(current)
  }
  throw new Error(`Cannot locate ${name}`)
}

for (const [name, record, patch] of [
  ['@nanmicoder/dsh-agent-teams', 'dsh-agent-teams@0.1.17.provenance.json', '@nanmicoder__dsh-agent-teams@0.1.17.patch'],
  ['@openviking/dsh-memory-plugin', 'openviking-0.3.0.integrity.json', '@openviking__dsh-memory-plugin@0.3.0.patch'],
  ['dsh-routing-suite', 'dsh-routing-suite@0.1.2.provenance.json', 'dsh-routing-suite@0.1.2.patch'],
]) {
  test(`${name} shows ClawMaster in its installed description`, async t => {
    const directory = await packageRoot(name)
    const provenance = JSON.parse(await readFile(join(desktop, 'patches', record), 'utf8'))
    const patchPath = join(desktop, 'patches', patch)
    assert.equal(sha(await readFile(patchPath)), provenance.patchSha256)
    const bytes = await readFile(join(directory, 'package.json'))
    const isPatched = sha(bytes) === provenance.patchedSha256['package.json']
    assert.ok(isPatched || sha(bytes) === provenance.upstreamSha256['package.json'])
    const temporary = await mkdtemp(join(tmpdir(), 'clawmaster-plugin-description-'))
    t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3 }))
    for (const side of ['upstream', 'patched']) {
      await mkdir(join(temporary, side))
      await writeFile(join(temporary, side, 'package.json'), bytes)
    }
    const result = spawnSync('git', ['apply', '--include=package.json', ...(isPatched ? ['--reverse'] : []), patchPath], {
      cwd: join(temporary, isPatched ? 'upstream' : 'patched'), encoding: 'utf8', timeout: 10000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    const beforeBytes = await readFile(join(temporary, 'upstream/package.json'))
    const afterBytes = await readFile(join(temporary, 'patched/package.json'))
    assert.equal(sha(beforeBytes), provenance.upstreamSha256['package.json'])
    assert.equal(sha(afterBytes), provenance.patchedSha256['package.json'])
    const before = JSON.parse(beforeBytes)
    const after = JSON.parse(afterBytes)
    assert.match(before.description, /DeepSeek Harness/u)
    assert.equal(after.description, before.description.replaceAll('DeepSeek Harness', 'ClawMaster'))
    delete before.description
    delete after.description
    assert.deepEqual(after, before)
    assert.equal(after.name, name)
    assert.equal(after.version, provenance.version)
    for (const [file, hash] of Object.entries(provenance.unchangedSha256)) {
      assert.equal(sha(await readFile(join(directory, file))), hash, file)
    }
  })
}
