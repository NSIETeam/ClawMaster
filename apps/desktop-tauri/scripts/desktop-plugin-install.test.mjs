/** Production dependency and profile verification against an installed, trimmed desktop tree. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { DESKTOP_BUNDLES, DESKTOP_PLUGIN_VERSIONS, prepareDesktopProfile } from './desktop-defaults.mjs'
import { assertDesktopLockfile } from './bundle-harness-source.mjs'

const root = resolve(process.env.DSH_DESKTOP_SMOKE_ROOT ?? fileURLToPath(new URL('../bundled/harness', import.meta.url)))
const anchor = join(root, 'apps/cli/package.json')
const resolver = createRequire(anchor)
const boot = await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-app-boot')).href)

test('installed plugins use reviewed versions, applied patches and one DSH workspace runtime', async t => {
  const home = mkdtempSync(join(tmpdir(), 'desktop-plugin-install-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }))
  assertDesktopLockfile(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), fileURLToPath(new URL('../patches', import.meta.url)))
  for (const [name, version] of Object.entries(DESKTOP_PLUGIN_VERSIONS)) {
    const path = realpathSync(boot.resolveBundleDir('ClawMaster', name, anchor, join(home, 'profiles/web')))
    assert.equal(JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version, version)
    if (['dsh-better-sidebar', '@nanmicoder/dsh-agent-teams', '@openviking/dsh-memory-plugin', 'dsh-routing-suite'].includes(name)) {
      const plugin = createRequire(join(path, 'package.json'))
      for (const [dependency, owner] of [['@deepseek-ai/dsh-session', 'packages/core/session'], ['@deepseek-ai/dsh-tools', 'packages/core/tools']]) {
        assert.equal(realpathSync(plugin.resolve(dependency)), realpathSync(join(root, owner, 'lib/index.js')))
        assert.equal(JSON.parse(readFileSync(join(root, owner, 'package.json'), 'utf8')).version, '0.1.5-rc.2')
      }
    }
    const provenance = {
      '@xmanrui/dsh-im': 'dsh-im@4.20.0.provenance.json',
      'dsh-better-sidebar': 'dsh-better-sidebar@0.19.1.provenance.json',
      '@nanmicoder/dsh-agent-teams': 'dsh-agent-teams@0.1.17.provenance.json',
      '@openviking/dsh-memory-plugin': 'openviking-0.3.0.integrity.json',
      'dsh-routing-suite': 'dsh-routing-suite@0.1.2.provenance.json',
    }[name]
    if (provenance) {
      const integrity = JSON.parse(readFileSync(new URL(`../patches/${provenance}`, import.meta.url), 'utf8'))
      for (const [file, expected] of Object.entries(integrity.patchedSha256)) {
        assert.equal(createHash('sha256').update(readFileSync(join(path, file))).digest('hex'), expected)
      }
    }
  }
  assert.deepEqual(readdirSync(join(root, 'node_modules/.pnpm')).filter(name => /^@deepseek-ai\+dsh(?:-|@)/.test(name)), [])
  await prepareDesktopProfile(root, home)
  const profile = boot.loadProfile('ClawMaster', 'web', anchor, home)
  assert.deepEqual(profile.layers.slice(2).map(layer => layer.packageName), DESKTOP_BUNDLES)
  const { applyEntryPatches } = await import(pathToFileURL(resolver.resolve('@deepseek-ai/cordis-plugin-include')).href)
  const entries = profile.layers.reduce((rows, layer) => applyEntryPatches(rows, layer.patches, () => {}), [])
  const memory = entries.find(entry => entry.id === 'openviking-memory').config.find(entry => entry.id === 'openviking-memory-runtime')
  assert.equal(memory.disabled, true)
  assert.equal(memory.name, '@openviking/dsh-memory-plugin')
  const routing = boot.resolveBundleDir('ClawMaster', 'dsh-routing-suite', anchor, join(home, 'profiles/web'))
  for (const file of ['preset.yml', 'agent.cordis.yml']) {
    assert.equal(readFileSync(join(home, '.agent-presets/routing-suite', file), 'utf8'), readFileSync(join(routing, 'preset/routing-suite', file), 'utf8'))
  }
})
