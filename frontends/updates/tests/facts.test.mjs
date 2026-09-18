import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readRuntimeFacts } from '../src/facts.ts'
import { Config, resolveConfig } from '../src/config.ts'

test('the Loader can validate an updater row with no config before calling apply', () => {
  const result = Config['~standard'].validate(undefined)
  assert.deepEqual(result, { value: resolveConfig({}) })
})

test('configuration rejects malformed deployment URLs, keys, paths, limits and locales before load', () => {
  assert.equal(resolveConfig().checkIntervalMs, 60_000)
  assert.equal(resolveConfig({ checkIntervalMs: 0 }).checkIntervalMs, 0)
  for (const value of [
    { dshHome: 'relative' }, { dshHome: '/tmp/../home' }, { publicKeyPem: 'private-or-invalid' },
    { nativePublicKey: 'invalid' }, { checkIntervalMs: -1 }, { checkIntervalMs: 2 ** 31 },
    { downloadTimeoutMs: 0 }, { maxExpandedBytes: 0 }, { locale: 'automatic' }, { maxArchiveEntries: 1.5 },
    ...['http://updates.test/latest.json', 'https://user:password@updates.test/latest.json', 'https://updates.test/latest.json?token=secret', 'https://updates.test/a/../latest.json'].map(catalogUrl => ({ catalogUrl })),
  ]) assert.throws(() => resolveConfig(value))
})

test('only this running Host can claim the desktop manifest version; stale facts fall back to the actual CLI', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-updates-facts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  await mkdir(join(home, 'desktop'), { recursive: true })
  const cli = join(root, 'runtime', 'apps', 'cli')
  await mkdir(join(cli, 'lib'), { recursive: true })
  await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }))
  const identity = { pid: 42, runId: 'run-this-host', entry: join(cli, 'lib', 'bin.js'), platform: 'darwin', arch: 'arm64', appImage: false }
  const current = { schemaVersion: 1, status: 'ready', hostPid: 42, runId: identity.runId, harnessVersion: '0.1.5-rc.2', desktopVersion: '0.2.1' }
  const path = join(home, 'desktop', 'current-runtime.json')
  await writeFile(path, JSON.stringify(current))
  const matched = await readRuntimeFacts(home, identity)
  assert.equal(matched.source, 'desktop-runtime')
  assert.equal(matched.desktopVersion, '0.2.1')
  assert.equal(matched.nativeTarget, 'darwin-aarch64')
  for (const change of [{ hostPid: 999 }, { runId: 'previous-run' }, { status: 'stopped' }]) {
    await writeFile(path, JSON.stringify({ ...current, ...change }))
    const facts = await readRuntimeFacts(home, identity)
    assert.equal(facts.source, 'dsh-package')
    assert.equal(facts.dshVersion, '0.1.5-rc.2')
    assert.equal(facts.desktopVersion, null)
  }
  await assert.rejects(readRuntimeFacts(home, { ...identity, statePath: join(root, 'other-home', 'current-runtime.json') }), /differs from the configured DSH home/)
  const unknown = await readRuntimeFacts(home, { ...identity, entry: undefined, runId: undefined, platform: 'linux', arch: 'x64' })
  assert.equal(unknown.source, 'unavailable')
  assert.equal(unknown.nativeTarget, null)
  assert.equal(unknown.dshVersion, null)
})
