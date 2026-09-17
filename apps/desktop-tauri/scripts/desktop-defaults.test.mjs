/** Isolated profile provisioning through the shipped app-boot artifact. */
import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { DESKTOP_BUNDLES, DESKTOP_OPTIONAL_BUNDLES, DESKTOP_PLUGIN_VERSIONS, DESKTOP_UPDATES_BUNDLE, prepareDesktopProfile } from './desktop-defaults.mjs'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(join(repository, 'apps/cli/package.json'))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'clawmaster defaults 空 #%-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))
  const cli = join(root, 'apps/cli')
  const modules = join(cli, 'node_modules')
  const home = join(root, 'home')
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  writeFileSync(join(cli, 'package.json'), '{"type":"module"}\n')
  symlinkSync(dirname(dirname(require.resolve('@deepseek-ai/dsh-app-boot'))), join(modules, '@deepseek-ai/dsh-app-boot'), 'junction')
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    const path = join(modules, name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(path, 'cordis.patch.yml'), name === '@deepseek-ai/dsh-base'
      ? '- insert:\n    - id: system-prompt\n      name: "@deepseek-ai/dsh-system-prompt"\n    - id: credentials\n      name: "@deepseek-ai/dsh-credentials-local"\n    - id: sandbox-policy\n      name: "@deepseek-ai/dsh-sandbox-policy"\n      config:\n        mode: workspace-write\n    - id: approval\n      name: "@deepseek-ai/dsh-user-approval"\n      config:\n        policy: ask\n    - id: permission\n      name: "@deepseek-ai/dsh-permission-presets"\n      config:\n        presets:\n          read-only:\n            sandbox: read-only\n            approval: ask\n          workspace-write:\n            sandbox: workspace-write\n            approval: ask\n          danger-full-access:\n            sandbox: danger-full-access\n            approval: never\n'
      : '[]\n')
  }
  for (const name of DESKTOP_BUNDLES) {
    const path = join(modules, name)
    mkdirSync(path, { recursive: true })
    const hostOnly = name === '@openviking/dsh-memory-plugin'
    const policy = name === '@clawmaster/dsh-desktop-policy'
    writeFileSync(join(path, 'package.json'), JSON.stringify({
      name, type: 'module', version: DESKTOP_PLUGIN_VERSIONS[name] ?? '0.3.1',
      exports: policy ? undefined : hostOnly ? { '.': './index.js' } : { '.': './index.js', './client': './client.js', './package.json': './package.json' },
      dsh: { bundle: { patch: './cordis.patch.yml' },
        ...(!hostOnly && !policy ? { client: { platform: 'web' } } : {}),
        ...(name === 'dsh-routing-suite' ? { desktop: { presets: [{ id: 'routing-suite', path: './preset/routing-suite' }] } } : {}),
      },
    }))
    writeFileSync(join(path, 'cordis.patch.yml'), name === '@clawmaster/dsh-credentials-keychain'
      ? readFileSync(join(repository, 'frontends/credentials-keychain/cordis.patch.yml'), 'utf8')
      : name === '@clawmaster/dsh-frontend'
      ? '- id: sandbox-policy\n  config:\n    mode: read-only\n    workspaceRoot: /fixture\n- id: approval\n  config:\n    policy: ask\n- id: permission\n  config:\n    defaultPreset: read-only\n    presets:\n      read-only:\n        sandbox: read-only\n        approval: ask\n      workspace-write:\n        sandbox: workspace-write\n        approval: ask\n      danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n'
      : '[]\n')
    writeFileSync(join(path, 'index.js'), 'export const name = "fixture"\n')
    if (name === '@clawmaster/dsh-credentials-keychain') {
      writeFileSync(join(path, 'index.js'), 'export default function credentialsKeychainFixture() {}\n')
    }
    writeFileSync(join(path, 'client.js'), 'export const name = "fixture-client"\n')
    if (hostOnly) writeFileSync(join(path, 'cordis.patch.yml'), '- insert:\n    - id: openviking-memory\n      name: cordis:group\n      group: true\n      config:\n        - id: openviking-memory-runtime\n          name: "@openviking/dsh-memory-plugin"\n')
    if (name === '@xmanrui/dsh-im') writeFileSync(join(path, 'cordis.patch.yml'), '- insert:\n    - id: xmanrui-dsh-im\n      name: "@xmanrui/dsh-im"\n')
    if (name === DESKTOP_UPDATES_BUNDLE) cpSync(fileURLToPath(new URL('../updates/cordis.patch.yml', import.meta.url)), join(path, 'cordis.patch.yml'))
    if (policy) cpSync(fileURLToPath(new URL('../defaults/cordis.patch.yml', import.meta.url)), join(path, 'cordis.patch.yml'))
    if (name === 'dsh-routing-suite') {
      mkdirSync(join(path, 'preset/routing-suite'), { recursive: true })
      writeFileSync(join(path, 'preset/routing-suite/preset.yml'), 'name: Routing fixture\n')
      writeFileSync(join(path, 'preset/routing-suite/agent.cordis.yml'), '[]\n')
    }
  }
  symlinkSync(modules, join(root, 'node_modules'), 'junction')
  return { root, cli, modules, home, profile: join(home, 'profiles/web') }
}

function prepareMinimalBootFixture(f, routingPatch) {
  const basePath = join(f.modules, '@deepseek-ai/dsh-base')
  const routingPath = join(f.modules, 'dsh-routing-suite')
  writeFileSync(join(basePath, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: permission',
    "      name: './core-permission.mjs'",
    '',
  ].join('\n'))
  writeFileSync(join(basePath, 'core-permission.mjs'), 'export function apply(ctx) { ctx.provide("corePermissionReady", true) }\n')
  writeFileSync(join(f.modules, '@clawmaster/dsh-desktop-policy/cordis.patch.yml'), '[]\n')
  writeFileSync(join(f.modules, '@clawmaster/dsh-frontend/cordis.patch.yml'), '[]\n')
  for (const name of DESKTOP_BUNDLES.filter(name => name !== 'dsh-routing-suite' && DESKTOP_OPTIONAL_BUNDLES.includes(name))) {
    writeFileSync(join(f.modules, name, 'cordis.patch.yml'), '- insert: [\n')
  }
  writeFileSync(join(routingPath, 'cordis.patch.yml'), routingPatch)
  writeFileSync(join(routingPath, 'optional-permission.mjs'), 'export function apply(ctx) { ctx.provide("optionalPermissionReady", true) }\n')
}

async function bootPreparedProfile(f) {
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const profile = boot.loadProfile('ClawMaster', 'web', join(f.cli, 'package.json'), f.home)
  const entries = boot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  const config = join(f.root, 'boot.cordis.yml')
  writeFileSync(config, '[]\n')
  const patches = [...profile.layers.flatMap(layer => layer.patches), ...profile.patches]
  const ctx = await boot.boot('ClawMaster', config, patches)
  return { ctx, entries }
}

test('fresh home gets every desktop bundle through the DSH profile format', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const manifest = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...DESKTOP_BUNDLES])
  assert.deepEqual(manifest.dsh.profile.optionalClientPackages, DESKTOP_BUNDLES.filter(name => DESKTOP_OPTIONAL_BUNDLES.includes(name)))
  assert.equal(manifest.dsh.profile.bundles.includes('@clawmaster/dsh-graph-memory'), true)
  assert.equal(manifest.dsh.profile.bundles.includes('@clawmaster/dsh-credentials-keychain'), true)
  assert.equal(DESKTOP_OPTIONAL_BUNDLES.includes('@clawmaster/dsh-credentials-keychain'), false)
  assert.deepEqual(manifest.dependencies, {})
  const patch = readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')
  const edited = { ...manifest, dependencies: { custom: '1.2.3' } }
  writeFileSync(join(f.profile, 'package.json'), JSON.stringify(edited))
  await prepareDesktopProfile(f.root, f.home)
  assert.deepEqual(JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8')), edited)
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch)
})

test('desktop credential profile replaces the active file provider for every credential consumer', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const profile = boot.loadProfile('ClawMaster', 'web', join(f.cli, 'package.json'), f.home)
  const entries = boot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  assert.equal(entries.find(entry => entry.id === 'credentials')?.disabled, true)
  assert.equal(entries.find(entry => entry.id === 'credentials-keychain')?.name, '@clawmaster/dsh-credentials-keychain')
})

test('fresh desktop profile fixes the least-privilege execution defaults', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const profile = boot.loadProfile('ClawMaster', 'web', join(f.cli, 'package.json'), f.home)
  const entries = boot.composeEntries([
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
  ])
  const config = id => entries.find(entry => entry.id === id)?.config
  assert.equal(config('sandbox-policy').mode, 'read-only')
  assert.equal(config('approval').policy, 'ask')
  assert.equal(config('permission').defaultPreset, 'read-only')
  assert.deepEqual(config('permission').presets['read-only'], { sandbox: 'read-only', approval: 'ask' })
  assert.deepEqual(config('permission').presets['danger-full-access'], { sandbox: 'danger-full-access', approval: 'never' })
})

test('IM channel defaults resolve under the selected home and preserve user overrides without selecting a Workspace', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const workspace = join(f.home, 'watchdog-workspaces', 'im')
  assert.equal(lstatSync(workspace).isDirectory(), true)
  if (process.platform !== 'win32') assert.equal(lstatSync(workspace).mode & 0o777, 0o700)
  writeFileSync(join(workspace, 'existing.txt'), 'preserved\n')
  const evaluate = () => {
    const script = `
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const require = createRequire(${JSON.stringify(join(repository, 'apps/cli/package.json'))});
      const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
      const { applyEntryPatches } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href);
      const { interpolate } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')).href);
      const { dshHomePath } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-home-paths')).href);
      const profile = boot.loadProfile('ClawMaster', 'web', ${JSON.stringify(join(f.cli, 'package.json'))}, process.env.DSH_HOME);
      const entries = [...profile.layers.map(layer => layer.patches), profile.patches]
        .reduce((entries, patches) => applyEntryPatches(entries, patches, (message, ...args) => { throw new Error([message, ...args].join(" ")) }), []);
      const config = entries.find(entry => entry.id === 'xmanrui-dsh-im').config;
      process.stdout.write(JSON.stringify(interpolate({ dshHomePath }, config)));
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: f.root, env: { ...process.env, DSH_HOME: f.home }, encoding: 'utf8', timeout: 15000, windowsHide: true,
    })
    assert.equal(child.error, undefined)
    assert.equal(child.signal, null)
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout)
  }
  const defaults = evaluate()
  for (const channel of ['weixin', 'feishu', 'dingtalk', 'wecom']) assert.equal(defaults[channel].workspace, workspace)
  assert.equal(defaults.workspace, undefined)
  const custom = join(f.home, 'custom-weixin')
  const patch = `- id: xmanrui-dsh-im\n  config:\n    weixin:\n      workspace: ${JSON.stringify(custom)}\n`
  writeFileSync(join(f.profile, 'cordis.patch.yml'), patch)
  await prepareDesktopProfile(f.root, f.home)
  const overridden = evaluate()
  assert.deepEqual(overridden, { weixin: { workspace: custom } })
  assert.equal(readFileSync(join(workspace, 'existing.txt'), 'utf8'), 'preserved\n')
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch)
  assert.equal(existsSync(custom), false)
  assert.equal(existsSync(join(f.home, 'storages', 'workspace.json')), false)
})

test('an IM workspace symlink disables only IM and preserves its target', async t => {
  const f = fixture(t)
  const outside = join(f.root, 'user-directory')
  const managed = join(f.home, 'watchdog-workspaces')
  mkdirSync(outside)
  writeFileSync(join(outside, 'kept.txt'), 'user data\n')
  mkdirSync(managed, { recursive: true })
  symlinkSync(outside, join(managed, 'im'), 'junction')
  await prepareDesktopProfile(f.root, f.home)
  const bundles = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8')).dsh.profile.bundles
  assert.equal(bundles.includes('@xmanrui/dsh-im'), false)
  assert.equal(bundles.includes('@clawmaster/dsh-frontend'), true)
  assert.equal(bundles.includes(DESKTOP_UPDATES_BUNDLE), true)
  assert.equal(lstatSync(join(managed, 'im')).isSymbolicLink(), true)
  assert.equal(readFileSync(join(outside, 'kept.txt'), 'utf8'), 'user data\n')
})

test('an unavailable optional bundle is omitted while the core profile is provisioned', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const manifestPath = join(f.modules, '@xmanrui/dsh-im/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '4.19.0' }))
  await prepareDesktopProfile(f.root, f.home)
  const profile = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(profile.dsh.profile.bundles.includes('@xmanrui/dsh-im'), false)
  assert.equal(profile.dsh.profile.optionalClientPackages.includes('@xmanrui/dsh-im'), true)
  assert.equal(profile.dsh.profile.bundles.includes('@clawmaster/dsh-frontend'), true)
  rmSync(join(f.modules, '@xmanrui/dsh-im'), { recursive: true })
  await prepareDesktopProfile(f.root, f.home)
  const repeated = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(repeated.dsh.profile.bundles.includes('@xmanrui/dsh-im'), false)
  assert.equal(repeated.dsh.profile.optionalClientPackages.includes('@xmanrui/dsh-im'), true)
})

test('a malformed optional bundle patch is omitted on fresh and existing profiles', async t => {
  const f = fixture(t)
  const patch = join(f.modules, 'dsh-routing-suite', 'cordis.patch.yml')
  writeFileSync(patch, '- insert: [\n')
  await prepareDesktopProfile(f.root, f.home)
  let profile = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(profile.dsh.profile.bundles.includes('dsh-routing-suite'), false)
  assert.equal(profile.dsh.profile.bundles.includes('@clawmaster/dsh-frontend'), true)
  writeFileSync(patch, '[]\n')
  await prepareDesktopProfile(f.root, f.home)
  writeFileSync(patch, '- insert: [\n')
  await prepareDesktopProfile(f.root, f.home)
  profile = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(profile.dsh.profile.bundles.includes('dsh-routing-suite'), false)
  assert.equal(profile.dsh.profile.bundles.includes('@clawmaster/dsh-frontend'), true)
})

test('a valid optional patch that duplicates a core Loader id is omitted before the profile is written', async t => {
  const f = fixture(t)
  prepareMinimalBootFixture(f, [
    '- insert:',
    '    - id: optional-permissions',
    '      name: cordis:group',
    '      group: true',
    '      config:',
    '        - id: permission',
    "          name: './optional-permission.mjs'",
    '',
  ].join('\n'))
  await prepareDesktopProfile(f.root, f.home)
  const profile = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(profile.dsh.profile.bundles.includes('dsh-routing-suite'), false)
  assert.equal(profile.dsh.profile.bundles.includes('@clawmaster/dsh-frontend'), true)
  assert.equal(existsSync(join(f.home, '.agent-presets', 'routing-suite')), false)
  const { ctx, entries } = await bootPreparedProfile(f)
  try {
    assert.deepEqual(entries.flatMap(entry => [entry.id, ...(entry.group && Array.isArray(entry.config) ? entry.config.map(child => child.id) : [])]).filter(id => id === 'permission'), ['permission'])
    assert.equal(ctx.get('corePermissionReady'), true)
    assert.equal(ctx.get('optionalPermissionReady'), undefined)
    assert.equal(ctx.loader.resolve('include:permission').fiber?.state, 2)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('an anonymous optional group cannot hide a duplicate core child id', async t => {
  const f = fixture(t)
  prepareMinimalBootFixture(f, [
    '- insert:',
    '    - name: cordis:group',
    '      group: true',
    '      config:',
    '        - id: permission',
    "          name: './optional-permission.mjs'",
    '',
  ].join('\n'))
  await prepareDesktopProfile(f.root, f.home)
  const profile = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(profile.dsh.profile.bundles.includes('dsh-routing-suite'), false)
  const { ctx } = await bootPreparedProfile(f)
  try {
    assert.equal(ctx.get('corePermissionReady'), true)
    assert.equal(ctx.get('optionalPermissionReady'), undefined)
    assert.equal(ctx.loader.resolve('include:permission').options.name.endsWith('/core-permission.mjs'), true)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a structurally invalid optional insert is omitted and the prepared profile boots READY', async t => {
  const f = fixture(t)
  prepareMinimalBootFixture(f, '- insert:\n    - broken\n')
  await prepareDesktopProfile(f.root, f.home)
  const profile = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(profile.dsh.profile.bundles.includes('dsh-routing-suite'), false)
  assert.equal(profile.dsh.profile.bundles.includes('@clawmaster/dsh-frontend'), true)
  const { ctx } = await bootPreparedProfile(f)
  try {
    assert.equal(ctx.get('corePermissionReady'), true)
    assert.equal(ctx.get('optionalPermissionReady'), undefined)
    assert.equal(ctx.loader.resolve('include:permission').fiber?.state, 2)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('an optional override with a malformed existing group is omitted before boot', async t => {
  const f = fixture(t)
  prepareMinimalBootFixture(f, '- id: openviking-memory\n  config:\n    - broken\n')
  writeFileSync(join(f.modules, '@deepseek-ai/dsh-base/core-group.mjs'), 'export function apply() {}\n')
  writeFileSync(join(f.modules, '@deepseek-ai/dsh-base/cordis.patch.yml'), [
    '- insert:',
    '    - id: permission',
    "      name: './core-permission.mjs'",
    '    - id: openviking-memory',
    "      name: './core-group.mjs'",
    '      group: true',
    '      config:',
    '        - id: existing-child',
    "          name: './core-group.mjs'",
    '',
  ].join('\n'))
  await prepareDesktopProfile(f.root, f.home)
  const profile = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(profile.dsh.profile.bundles.includes('dsh-routing-suite'), false)
  const { ctx } = await bootPreparedProfile(f)
  try {
    assert.equal(ctx.get('corePermissionReady'), true)
    assert.equal(ctx.get('optionalPermissionReady'), undefined)
    assert.equal(ctx.loader.resolve('include:permission').fiber?.state, 2)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a user Loader insert without an id keeps its generated id and boots', async t => {
  const f = fixture(t)
  prepareMinimalBootFixture(f, '[]\n')
  mkdirSync(f.profile, { recursive: true })
  writeFileSync(join(f.profile, 'optional-user.mjs'), 'export function apply() {}\n')
  writeFileSync(join(f.profile, 'cordis.patch.yml'), '- insert:\n    - name: ./optional-user.mjs\n')
  await prepareDesktopProfile(f.root, f.home)
  const { ctx } = await bootPreparedProfile(f)
  try {
    assert.equal(ctx.get('corePermissionReady'), true)
    const userEntry = [...ctx.loader.entries()].find(entry => entry.options.name.endsWith('/optional-user.mjs'))
    assert.equal(typeof userEntry?.id, 'string')
    assert.ok(userEntry.id.length > 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a valid optional patch that duplicates a user Loader id is omitted while the user patch is preserved', async t => {
  const f = fixture(t)
  const userPatch = '- insert:\n    - id: user-owned-row\n      name: ./user-owned.mjs\n'
  mkdirSync(f.profile, { recursive: true })
  writeFileSync(join(f.profile, 'cordis.patch.yml'), userPatch)
  writeFileSync(join(f.modules, 'dsh-routing-suite/cordis.patch.yml'), [
    '- insert:',
    '    - id: user-owned-row',
    "      name: './duplicate-user-row.mjs'",
    '',
  ].join('\n'))
  await prepareDesktopProfile(f.root, f.home)
  const profile = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(profile.dsh.profile.bundles.includes('dsh-routing-suite'), false)
  assert.equal(profile.dsh.profile.bundles.includes('@clawmaster/dsh-frontend'), true)
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), userPatch)
})

test('a conflicting optional preset destination disables that component without replacing user data', async t => {
  const f = fixture(t)
  mkdirSync(join(f.home, '.agent-presets'), { recursive: true })
  const destination = join(f.home, '.agent-presets', 'routing-suite')
  writeFileSync(destination, 'user data\n')
  await prepareDesktopProfile(f.root, f.home)
  const profile = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(profile.dsh.profile.bundles.includes('dsh-routing-suite'), false)
  assert.equal(profile.dsh.profile.bundles.includes('@clawmaster/dsh-frontend'), true)
  assert.equal(readFileSync(destination, 'utf8'), 'user data\n')
})

test('an unavailable IM workspace skips only IM and preserves the conflicting file', async t => {
  const f = fixture(t)
  const workspace = join(f.home, 'watchdog-workspaces', 'im')
  mkdirSync(join(f.home, 'watchdog-workspaces'), { recursive: true })
  writeFileSync(workspace, 'user data\n')
  await prepareDesktopProfile(f.root, f.home)
  const bundles = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8')).dsh.profile.bundles
  assert.equal(bundles.includes('@xmanrui/dsh-im'), false)
  assert.equal(bundles.includes('@clawmaster/dsh-frontend'), true)
  assert.equal(bundles.includes(DESKTOP_UPDATES_BUNDLE), true)
  assert.equal(readFileSync(workspace, 'utf8'), 'user data\n')
})

test('presets from a Loader-rejected optional bundle cannot remove a healthy updater', async t => {
  const f = fixture(t)
  const routingPath = join(f.modules, 'dsh-routing-suite')
  writeFileSync(join(routingPath, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: user-owned-row',
    "      name: '@deepseek-ai/dsh-base'",
    '',
  ].join('\n'))
  mkdirSync(f.home, { recursive: true })
  writeFileSync(join(f.home, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: user-owned-row',
    "      name: '@deepseek-ai/dsh-base'",
    '',
  ].join('\n'))
  const teamsPath = join(f.modules, '@nanmicoder/dsh-agent-teams')
  const teamsManifestPath = join(teamsPath, 'package.json')
  const teamsManifest = JSON.parse(readFileSync(teamsManifestPath, 'utf8'))
  writeFileSync(teamsManifestPath, JSON.stringify({
    ...teamsManifest,
    dsh: { ...teamsManifest.dsh, desktop: { presets: [{ id: 'routing-suite', path: './preset/routing-suite' }] } },
  }))
  mkdirSync(join(teamsPath, 'preset/routing-suite'), { recursive: true })
  writeFileSync(join(teamsPath, 'preset/routing-suite/preset.yml'), 'name: Teams fixture\n')
  writeFileSync(join(teamsPath, 'preset/routing-suite/agent.cordis.yml'), '[]\n')

  await prepareDesktopProfile(f.root, f.home)

  const bundles = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8')).dsh.profile.bundles
  assert.equal(bundles.includes('dsh-routing-suite'), false)
  assert.equal(bundles.includes('@nanmicoder/dsh-agent-teams'), true)
  assert.equal(bundles.includes(DESKTOP_UPDATES_BUNDLE), true)
  assert.equal(readFileSync(join(f.home, '.agent-presets/routing-suite/preset.yml'), 'utf8'), 'name: Teams fixture\n')
})

test('an updater declared only by a rejected existing optional bundle does not suppress the desktop updater', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const routingPath = join(f.modules, 'dsh-routing-suite')
  writeFileSync(join(routingPath, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: permission',
    '      name: "@deepseek-ai/dsh-base"',
    '    - id: optional-updater',
    '      name: "@clawmaster/dsh-updates"',
    '',
  ].join('\n'))

  await prepareDesktopProfile(f.root, f.home)

  const bundles = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8')).dsh.profile.bundles
  assert.equal(bundles.includes('dsh-routing-suite'), false)
  assert.equal(bundles.includes(DESKTOP_UPDATES_BUNDLE), true)
})

test('the desktop updater is restored when its duplicate-row owner is later excluded by preset validation', async t => {
  const f = fixture(t)
  const routingPath = join(f.modules, 'dsh-routing-suite')
  writeFileSync(join(routingPath, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: clawmaster-update-component-updates',
    '      name: "@clawmaster/dsh-updates"',
    '',
  ].join('\n'))
  mkdirSync(join(f.home, '.agent-presets'), { recursive: true })
  writeFileSync(join(f.home, '.agent-presets/routing-suite'), 'user data\n')

  await prepareDesktopProfile(f.root, f.home)

  const bundles = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8')).dsh.profile.bundles
  assert.equal(bundles.includes('dsh-routing-suite'), false)
  assert.equal(bundles.includes(DESKTOP_UPDATES_BUNDLE), true)
  assert.equal(readFileSync(join(f.home, '.agent-presets/routing-suite'), 'utf8'), 'user data\n')
})

test('colliding optional preset declarations disable both components before copying either preset', async t => {
  const f = fixture(t)
  const destination = join(f.home, '.agent-presets', 'routing-suite')
  const teamsPath = join(f.modules, '@nanmicoder/dsh-agent-teams')
  const teamsManifestPath = join(teamsPath, 'package.json')
  const teamsManifest = JSON.parse(readFileSync(teamsManifestPath, 'utf8'))
  writeFileSync(teamsManifestPath, JSON.stringify({
    ...teamsManifest,
    dsh: { ...teamsManifest.dsh, desktop: { presets: [{ id: 'routing-suite', path: './preset/routing-suite' }] } },
  }))
  mkdirSync(join(teamsPath, 'preset/routing-suite'), { recursive: true })
  writeFileSync(join(teamsPath, 'preset/routing-suite/preset.yml'), 'name: Teams fixture\n')
  writeFileSync(join(teamsPath, 'preset/routing-suite/agent.cordis.yml'), '[]\n')
  await prepareDesktopProfile(f.root, f.home)
  const bundles = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8')).dsh.profile.bundles
  assert.equal(bundles.includes('dsh-routing-suite'), false)
  assert.equal(bundles.includes('@nanmicoder/dsh-agent-teams'), false)
  assert.equal(bundles.includes('@clawmaster/dsh-frontend'), true)
  assert.equal(existsSync(destination), false)
})

test('a missing desktop core bundle still rejects startup', async t => {
  const f = fixture(t)
  rmSync(join(f.modules, '@clawmaster/dsh-frontend'), { recursive: true })
  await assert.rejects(prepareDesktopProfile(f.root, f.home), /cannot resolve profile bundle/)
  assert.equal(existsSync(f.home), false)
})

test('host-only OpenViking remains visible but disabled until a user patch enables it', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const { applyEntryPatches } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href)
  const composition = () => {
    const profile = boot.loadProfile('ClawMaster', 'web', join(f.cli, 'package.json'), f.home)
    return [...profile.layers.map(layer => layer.patches), profile.patches]
      .reduce((entries, patches) => applyEntryPatches(entries, patches, (message, ...args) => { throw new Error([message, ...args].join(" ")) }), [])
  }
  const runtime = () => composition().find(entry => entry.id === 'openviking-memory').config[0]
  assert.equal(runtime().name, '@openviking/dsh-memory-plugin')
  assert.equal(runtime().disabled, true)
  const patch = '- id: openviking-memory-runtime\n  disabled: false\n  config:\n    endpoint: http://localhost:1933\n'
  writeFileSync(join(f.profile, 'cordis.patch.yml'), patch)
  await prepareDesktopProfile(f.root, f.home)
  assert.equal(runtime().disabled, false)
  assert.equal(runtime().config.endpoint, 'http://localhost:1933')
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch)
})

test('routing preset provisioning fills missing files and preserves user edits', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const preset = join(f.home, '.agent-presets/routing-suite')
  assert.equal(readFileSync(join(preset, 'preset.yml'), 'utf8'), 'name: Routing fixture\n')
  writeFileSync(join(preset, 'preset.yml'), 'name: User routing\n')
  rmSync(join(preset, 'agent.cordis.yml'))
  await prepareDesktopProfile(f.root, f.home)
  assert.equal(readFileSync(join(preset, 'preset.yml'), 'utf8'), 'name: User routing\n')
  assert.equal(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8'), '[]\n')
})

test('Node preload prepares the profile once and consumes its inherited activation flag', t => {
  const f = fixture(t)
  const preload = join(f.root, 'desktop-defaults.mjs')
  cpSync(fileURLToPath(new URL('./desktop-defaults.mjs', import.meta.url)), preload)
  mkdirSync(join(f.cli, 'lib'))
  const entry = join(f.cli, 'lib/bin.js')
  writeFileSync(entry, 'if (process.env.DSH_DESKTOP_DEFAULTS !== undefined) throw new Error("activation flag leaked")\n')
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, entry], {
    env: { ...process.env, DSH_HOME: f.home, DSH_DESKTOP_DEFAULTS: '1' },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(f.profile, 'package.json')), true)
})

for (const location of ['profile', 'home']) {
  test(`existing ${location} updater insertion retains one Loader row and its exact user patch`, async t => {
    const f = fixture(t)
    await prepareDesktopProfile(f.root, f.home)
    const patchPath = join(location === 'profile' ? f.profile : f.home, 'cordis.patch.yml')
    const entry = pathToFileURL(join(f.home, 'clawmaster-updates/components/updates/0.1.0/package/dist/index.js')).href
    const patch = `# User-installed updater and custom settings must survive.\n- insert:\n    - id: clawmaster-update-component-updates\n      name: ${JSON.stringify(entry)}\n      disabled: true\n- id: xmanrui-dsh-im\n  disabled: true\n`
    writeFileSync(patchPath, patch)
    await prepareDesktopProfile(f.root, f.home)
    await prepareDesktopProfile(f.root, f.home)
    const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
    const profile = boot.loadProfile('ClawMaster', 'web', join(f.cli, 'package.json'), f.home)
    assert.equal(profile.layers.some(layer => layer.packageName === DESKTOP_UPDATES_BUNDLE), false)
    const entries = boot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches, boot.loadOptionalPatches('ClawMaster', join(f.home, 'cordis.patch.yml')) ?? []])
    const updaters = entries.filter(entry => entry.id === 'clawmaster-update-component-updates')
    assert.equal(updaters.length, 1)
    assert.equal(updaters[0].name, entry)
    assert.equal(updaters[0].disabled, true)
    assert.equal(readFileSync(patchPath, 'utf8'), patch)
    rmSync(patchPath)
    await prepareDesktopProfile(f.root, f.home)
    assert.equal(JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8')).dsh.profile.bundles.includes(DESKTOP_UPDATES_BUNDLE), true)
  })
}

test('an existing user bundle updater prevents the desktop updater from being added', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const custom = join(f.modules, 'custom-updater')
  mkdirSync(custom)
  writeFileSync(join(custom, 'package.json'), JSON.stringify({
    name: 'custom-updater',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(custom, 'cordis.patch.yml'), '- insert:\n    - id: custom-updater-row\n      name: "@clawmaster/dsh-updates"\n')
  const manifestPath = join(f.profile, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles.push('custom-updater')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  await prepareDesktopProfile(f.root, f.home)
  await prepareDesktopProfile(f.root, f.home)
  const profile = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(profile.dsh.profile.bundles.includes('custom-updater'), true)
  assert.equal(profile.dsh.profile.bundles.includes(DESKTOP_UPDATES_BUNDLE), false)
})

test('updater bootstrap rejects a fresh desktop profile without adding a second updater', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const updater = await import(new URL('../../../frontends/updates/dist/index.js', import.meta.url).href)
  const { create } = createRequire(new URL('../../../frontends/updates/package.json', import.meta.url))('tar')
  const source = join(f.root, 'archive-source')
  mkdirSync(join(source, 'package/dist'), { recursive: true })
  writeFileSync(join(source, 'package/package.json'), JSON.stringify({ name: '@clawmaster/dsh-updates', version: '0.1.0', type: 'module' }))
  writeFileSync(join(source, 'package/dist/index.js'), 'export const name = "fixture"\n')
  const archivePath = join(f.root, 'component.tgz')
  await create({ cwd: source, file: archivePath, gzip: true }, ['package'])
  await updater.installComponent({ archivePath, dshHome: f.home, dshVersion: '0.1.5-rc.2', descriptor: { id: 'updates', packageName: '@clawmaster/dsh-updates', version: '0.1.0', entry: './dist/index.js', kind: 'component', activation: 'restart', requiresDshVersion: '>=0.1.5-rc.2' } })
  const manifest = readFileSync(join(f.profile, 'package.json'), 'utf8')
  const patch = readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')
  await assert.rejects(updater.bootstrapUpdater({ dshHome: f.home, version: '0.1.0', expectedPatchRevision: await updater.readComponentPatchRevision(f.home), confirmed: true }), /profile already declares the updater/)
  assert.equal(readFileSync(join(f.profile, 'package.json'), 'utf8'), manifest)
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch)
})
