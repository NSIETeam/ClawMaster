import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { captureBuildSource, desktopBuildMode, recordHarnessBuild, recordPreparedBuild, verifyHarnessBuild, verifyPreparedBuild } from './build-provenance.mjs'

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-source-binding-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const git = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q'])
  git(['config', 'user.name', 'Build fixture'])
  git(['config', 'user.email', 'build@example.invalid'])
  git(['config', 'core.autocrlf', 'false'])
  git(['config', 'commit.gpgsign', 'false'])
  write(root, '.gitignore', 'lib/\ndist/\n.dsh-build/\n')
  write(root, 'source.js', 'export const answer = 20\n')
  write(root, 'frontends/dsh/src/clawmaster.svg', '<svg><path d="M0 0h1v1z"/></svg>\n')
  write(root, 'apps/desktop-tauri/src-tauri/icons/icon.icns', 'committed generated icon')
  git(['add', '.'])
  git(['commit', '-qm', 'fixture source'])
  return { root, git }
}

// Use a real compiler subprocess with source input distinct from emitted output.
function compile(root) {
  const esbuild = pathToFileURL(createRequire(new URL('../../../frontends/dsh/package.json', import.meta.url)).resolve('esbuild')).href
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { buildSync } from ${JSON.stringify(esbuild)};
    buildSync({ entryPoints: ['source.js'], outfile: 'apps/cli/lib/bin.js', bundle: true, platform: 'node', format: 'esm' });
  `], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
}

test('release checks reject unstaged, staged and untracked source before compilation', t => {
  const { root, git } = fixture(t)
  const clean = captureBuildSource(root, 'release')
  assert.equal(clean.dirty, false)
  assert.equal(clean.gitCommit.length, 40)
  assert.equal(clean.gitTree.length, 40)
  write(root, 'source.js', 'export const answer = 21\n')
  assert.throws(() => captureBuildSource(root, 'release'), /Release requires clean source.*source.js/)
  git(['add', 'source.js'])
  assert.throws(() => captureBuildSource(root, 'release'), /Release requires clean source/)
  write(root, 'source.js', 'export const answer = 20\n')
  assert.throws(() => captureBuildSource(root, 'release'), /Release requires clean source/)
  git(['reset', '--hard', '-q', 'HEAD'])
  write(root, 'untracked.js', 'export const changed = true\n')
  assert.throws(() => captureBuildSource(root, 'release'), /untracked.js/)
  const development = captureBuildSource(root, 'development')
  assert.equal(development.dirty, true)
  assert.deepEqual(development.dirtyFiles, ['untracked.js'])
  assert.notEqual(development.sourceSha256, clean.sourceSha256)
})

test('unchanged emitted bytes cannot satisfy source changes after a successful build', t => {
  const { root } = fixture(t)
  const source = captureBuildSource(root, 'development')
  compile(root)
  recordHarnessBuild(root, source, 'development')
  assert.doesNotThrow(() => verifyHarnessBuild(root, 'development'))
  const output = readFileSync(join(root, 'apps/cli/lib/bin.js'), 'utf8')
  write(root, 'source.js', 'export const answer = 22\n')
  assert.equal(readFileSync(join(root, 'apps/cli/lib/bin.js'), 'utf8'), output)
  assert.throws(() => verifyHarnessBuild(root, 'development'), /source differs/)
  assert.throws(() => recordHarnessBuild(root, source, 'development'), /source differs/)
})

test('Host or client artifact replacement is rejected even when source and Git commit match', t => {
  const { root } = fixture(t)
  const source = captureBuildSource(root, 'release')
  compile(root)
  write(root, 'packages/client/example/lib/client.js', 'client built from source')
  recordHarnessBuild(root, source, 'release')
  write(root, 'apps/cli/lib/bin.js', 'stale Host artifact')
  assert.deepEqual(captureBuildSource(root, 'release'), source)
  assert.throws(() => verifyHarnessBuild(root, 'release'), /harness artifacts differ/)
  compile(root)
  assert.doesNotThrow(() => verifyHarnessBuild(root, 'release'))
  write(root, 'packages/client/example/lib/client.js', 'stale client artifact')
  assert.throws(() => verifyHarnessBuild(root, 'release'), /harness artifacts differ/)
})

test('development records are labelled dirty and cannot be reused as release records', t => {
  const { root } = fixture(t)
  write(root, 'source.js', 'export const answer = 23\n')
  const source = captureBuildSource(root, 'development')
  compile(root)
  recordHarnessBuild(root, source, 'development')
  write(root, 'frontends/dsh/dist/client.js', 'product client')
  const record = recordPreparedBuild(root, source, 'development')
  assert.match(record.buildId, /^development-dirty-[a-f0-9]{12}-[a-f0-9]{12}$/)
  assert.equal(record.source.dirty, true)
  assert.deepEqual(record.source.dirtyFiles, ['source.js'])
  assert.throws(() => verifyPreparedBuild(root, 'release'), /another build mode/)
})

test('regenerated native icons stay outside source identity but remain verified product artifacts', t => {
  const { root } = fixture(t)
  const source = captureBuildSource(root, 'release')
  compile(root)
  recordHarnessBuild(root, source, 'release')
  write(root, 'apps/desktop-tauri/src-tauri/icons/icon.icns', 'new deterministic artwork, platform encoder bytes')
  assert.deepEqual(captureBuildSource(root, 'release'), source)
  write(root, 'frontends/dsh/dist/client.js', 'fresh product frontend')
  recordPreparedBuild(root, source, 'release')
  assert.doesNotThrow(() => verifyPreparedBuild(root, 'release'))
  write(root, 'frontends/dsh/dist/client.js', 'stale product frontend')
  assert.throws(() => verifyPreparedBuild(root, 'release'), /product artifacts differ/)
  write(root, 'frontends/dsh/dist/client.js', 'fresh product frontend')
  write(root, 'apps/desktop-tauri/src-tauri/icons/icon.icns', 'replaced after preparation')
  assert.throws(() => verifyPreparedBuild(root, 'release'), /product artifacts differ/)
})

test('missing source records and invalid build modes fail before packaging', t => {
  const { root } = fixture(t)
  assert.throws(() => verifyHarnessBuild(root, 'development'), /provenance missing/)
  assert.equal(desktopBuildMode({}), 'development')
  assert.throws(() => desktopBuildMode({ DSH_DESKTOP_BUILD_MODE: 'production' }), /must be release or development/)
})
