import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Entry guards must resolve the invoked path, not only absolutize it. */
const symlinkResolvingGuard = /\brealpathSync\(/u
/** Release-critical scripts an operator runs by hand from a checkout. */
const OPERATOR_ENTRY_POINTS = [
  'release-acceptance.mjs',
  'copy-release-evidence.mjs',
  'verify-release-assets.mjs',
  'verify-release-build-run.mjs',
  'desktop-version.mjs',
  'release-version-guard.mjs',
  'release-channel.mjs',
]

/** Guard lines a script uses to decide whether it is the process entry point. */
function guardLinesOf(source) {
  return source.split('\n').filter(line => line.includes('process.argv[1]') && line.includes('import.meta.url'))
}

test('every desktop entry guard resolves symlinks before comparing paths', async () => {
  const names = (await readdir(SCRIPT_DIR))
    .filter(name => (name.endsWith('.mjs') || name.endsWith('.ts')) && !name.endsWith('.test.mjs'))
    .sort()
  assert.ok(names.length > 25, `Expected the desktop script directory to hold many scripts, saw ${names.length}`)
  const guarded = new Set()
  for (const name of names) {
    const source = await readFile(path.join(SCRIPT_DIR, name), 'utf8')
    for (const line of guardLinesOf(source)) {
      assert.match(line, symlinkResolvingGuard,
        `${name} compares the entry point without realpathSync, so the script silently does nothing when its path traverses a symlink: ${line.trim()}`)
    }
    if (guardLinesOf(source).length > 0) guarded.add(name)
  }
  for (const name of OPERATOR_ENTRY_POINTS) {
    assert.ok(guarded.has(name), `${name} has no entry guard, so it never runs when invoked as a script`)
  }
  // Negative fixtures: the three forms this gate replaced must not satisfy it.
  assert.doesNotMatch('if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {', symlinkResolvingGuard)
  assert.doesNotMatch('if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {', symlinkResolvingGuard)
  assert.doesNotMatch('if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {', symlinkResolvingGuard)
})

test('a script invoked through a symlinked directory still reaches its entry point', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-entry-guard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const linked = path.join(root, 'scripts')
  try {
    await symlink(SCRIPT_DIR, linked, 'dir')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`This platform forbids directory symlinks (${error.code}), so the invoked-through-a-link case cannot be exercised here`)
      return
    }
    throw error
  }
  const result = spawnSync(process.execPath, [
    path.join(linked, 'release-acceptance.mjs'),
    '--template', '--version', '0.0.1-beta.4', '--commit', 'a'.repeat(40), '--upgrade-from', '0.0.1-beta.3',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.notEqual(result.stdout.trim(), '', 'The entry point did not run, so no manifest template was printed')
  const manifest = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(manifest.targets).sort(), ['macos-arm64-dmg', 'windows-x64-nsis'])
})
