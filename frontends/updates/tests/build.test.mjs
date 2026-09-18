/** Real bundler subprocesses must not encode the dependency installation's physical location. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const source = fileURLToPath(new URL('..', import.meta.url))
const artifacts = ['index.js', 'install.mjs', 'maintenance.mjs']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('actual builds at different checkout depths have identical bytes with linked pinned dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-reproducible-updates-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dependencyRoot = await realpath(join(source, 'node_modules'))
  const roots = [join(root, 'checkout-a'), join(root, '另一处 checkout', 'nested', 'updates')]
  const results = []
  for (const target of roots) {
    await mkdir(target, { recursive: true })
    for (const name of ['src', 'scripts', 'package.json']) await cp(join(source, name), join(target, name), { recursive: true })
    await symlink(join(source, 'node_modules'), join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await execute(process.execPath, [join(target, 'scripts/build.mjs')], { cwd: target, timeout: 60000 })
    await execute(process.execPath, [join(target, 'scripts/build.mjs'), '--check'], { cwd: target, timeout: 60000 })
    results.push(Object.fromEntries(await Promise.all(artifacts.map(async name => {
      const bytes = await readFile(join(target, 'dist', name))
      assert.equal(bytes.includes(Buffer.from(root)), false, 'Artifacts must not retain the temporary checkout path')
      assert.equal(bytes.includes(Buffer.from(dependencyRoot)), false, 'Artifacts must not retain the physical dependency path')
      return [name, digest(bytes)]
    }))))
  }
  assert.deepEqual(results[0], results[1], 'Checkout and symlink-target locations must not change emitted artifact hashes')
  await appendFile(join(roots[1], 'dist/index.js'), '\n// Unreviewed output change\n')
  await assert.rejects(execute(process.execPath, [join(roots[1], 'scripts/build.mjs'), '--check'], { cwd: roots[1], timeout: 60000 }),
    error => error.code !== 0 && /Stale update artifact/.test(error.stderr))
})
