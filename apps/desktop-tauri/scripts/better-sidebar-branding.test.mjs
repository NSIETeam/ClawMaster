/** Localized desktop copy in the pinned Better Sidebar source and published client artifacts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const dependencies = createRequire(join(repository, 'apps/web/package.json'))
const typescript = createRequire(join(repository, 'package.json'))('typescript')
const core = resolve(process.env.DSH_DESKTOP_SMOKE_ROOT ?? join(repository, 'apps/desktop-tauri/bundled/harness'))
const resolver = createRequire(join(core, 'apps/cli/package.json'))
const packageRoot = process.env.DSH_SIDEBAR_TEST_PACKAGE_ROOT
  ? resolve(process.env.DSH_SIDEBAR_TEST_PACKAGE_ROOT)
  : dirname(resolver.resolve('dsh-better-sidebar/package.json'))
const patchPath = fileURLToPath(new URL('../patches/dsh-better-sidebar@0.19.1.patch', import.meta.url))
const provenance = JSON.parse(await readFile(fileURLToPath(new URL('../patches/dsh-better-sidebar@0.19.1.provenance.json', import.meta.url)), 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const brandedKeys = ['settingsTitleBarDesc', 'settingsSchemeWebTitle', 'addPluginsTabDesc', 'addPluginsViewerDesc',
  'pluginSuhuangScrollDesc', 'pluginDocsPanelDesc', 'pluginEgoBrowserDesc', 'pluginBilingualReaderDesc']
const clientBundles = ['client.js', 'client-registry.js', 'client-terminal.js', 'client-editor.js', 'client-mermaid.js']
const isClientFile = file => file.startsWith('src/client/') || file.startsWith('lib/types/client/')
  || /^lib\/client(?:-[^/]+)?\.js$/.test(file)

/** Read the package's isolated dictionaries without a browser or a plugin Host. */
async function dictionaries(root) {
  const result = new Map()
  for (const file of (await readdir(join(root, 'src/client'))).filter(name => /^locales(?:-.+)?\.ts$/.test(name))) {
    const source = await readFile(join(root, 'src/client', file), 'utf8')
    const exports = {}
    vm.runInNewContext(typescript.transpileModule(source, {
      compilerOptions: { module: typescript.ModuleKind.CommonJS },
    }).outputText, { exports }, { filename: file })
    if (file === 'locales.ts') {
      result.set('zh', exports.zh)
      result.set('en', exports.en)
    } else {
      const values = Object.values(exports).filter(value => typeof value === 'object' && value !== null)
      assert.equal(values.length, 1, file)
      result.set(file.slice('locales-'.length, -'.ts'.length), values[0])
    }
  }
  return result
}

/** Reject product-brand leftovers while keeping the native dependency compatibility statement. */
function checkCopy(dict, locale) {
  for (const [key, value] of Object.entries(dict)) {
    assert.doesNotMatch(value, /DeepSeek\s+Harness/i, `${locale}.${key}`)
  }
  for (const key of brandedKeys) {
    assert.equal(typeof dict[key], 'string', `${locale}.${key}`)
    assert.doesNotMatch(dict[key], /DSH/, `${locale}.${key}`)
  }
  assert.match(dict.presetElectronTitle, /Electron/, locale)
  assert.match(dict.terminalDepsHint, /ClawMaster/, locale)
  assert.equal(dict.terminalDepsHint.match(/DSH/g)?.length, 1, `${locale}: DSH core compatibility stays explicit`)
  assert.match(dict.terminalDepsHint, /node-pty/, locale)
}

/** Expose the actual published factory's locale and preset functions in an isolated context. */
async function client(root) {
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  const end = 'return module.exports;'
  assert.equal(source.split(end).length, 2)
  let factory
  vm.runInNewContext(source.replace(end,
    'return { zh, en, t, attachLocale, attachBetterLocale, getShellPresets, builtinTabPlugins };'), {
    window: { __ModuleLoader__: { load: entry => { factory = entry.factory } } }, navigator: { language: 'en' },
  }, { filename: 'dsh-better-sidebar/lib/client.js' })
  return factory(id => id === '@deepseek-ai/dsh-client-ui-primitives'
    ? new Proxy({}, { get: () => () => null })
    : dependencies(id))
}

test('Better Sidebar localizes desktop branding without changing plugin commands or shell behavior', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'clawmaster-sidebar-branding-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3 }))
  const original = join(temporary, 'original')
  const patched = join(temporary, 'patched')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-better-sidebar')
  assert.equal(manifest.version, '0.19.1')
  assert.equal(sha(await readFile(patchPath)), provenance.patchSha256)
  const installedHash = sha(await readFile(join(packageRoot, 'lib/client.js')))
  const isPatched = installedHash === provenance.patchedSha256['lib/client.js']
  assert.ok(isPatched || installedHash === provenance.upstreamSha256['lib/client.js'], 'unknown plugin artifact')
  // Office Host edits have separate save coverage and input provenance.
  const clientFiles = Object.keys(provenance.patchedSha256).filter(isClientFile)
  assert.deepEqual(clientFiles.toSorted(), Object.keys(provenance.upstreamSha256).filter(isClientFile).toSorted())
  for (const file of clientFiles) {
    assert.equal(sha(await readFile(join(packageRoot, file))), (isPatched ? provenance.patchedSha256 : provenance.upstreamSha256)[file], file)
    for (const destination of [original, patched]) {
      await mkdir(dirname(join(destination, file)), { recursive: true })
      await cp(join(packageRoot, file), join(destination, file))
    }
  }
  const applied = spawnSync('git', ['apply', ...(isPatched ? ['--reverse'] : []),
    ...clientFiles.map(file => `--include=${file}`), patchPath], {
    cwd: isPatched ? original : patched, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(applied.error, undefined)
  assert.equal(applied.signal, null)
  assert.equal(applied.status, 0, applied.stderr)
  for (const file of clientFiles) {
    assert.equal(sha(await readFile(join(original, file))), provenance.upstreamSha256[file], `original ${file}`)
    assert.equal(sha(await readFile(join(patched, file))), provenance.patchedSha256[file], `patched ${file}`)
  }

  const before = await dictionaries(original)
  const after = await dictionaries(patched)
  assert.equal(after.size, 21)
  for (const [locale, dict] of after) {
    assert.throws(() => checkCopy(before.get(locale), locale), undefined, `${locale}: original copy fails branding check`)
    checkCopy(dict, locale)
    assert.equal(dict.presetDshDesktopDesc, before.get(locale).presetDshDesktopDesc, `${locale}: shell compatibility details`)
  }
  for (const name of clientBundles) {
    const source = await readFile(join(patched, 'lib', name), 'utf8')
    assert.doesNotMatch(source, /DeepSeek\s+Harness/i, name)
    for (const locale of ['zh', 'en']) {
      for (const key of [...brandedKeys, 'terminalDepsHint', 'presetElectronTitle']) {
        assert.ok(source.includes(`${key}: ${JSON.stringify(after.get(locale)[key])}`), `${name}: ${locale}.${key}`)
      }
    }
  }

  const upstream = await client(original)
  const desktop = await client(patched)
  const preset = desktop.getShellPresets()[0]
  assert.equal(preset.id, 'dsh-desktop')
  assert.equal(upstream.getShellPresets()[0].title, 'DeepSeek Harness Desktop')
  for (const [locale, dict] of after) {
    desktop.attachLocale({ getSnapshot: () => ({ active: locale === 'zh' ? 'zh' : 'en' }) })
    desktop.attachBetterLocale(locale === 'zh' || locale === 'en' ? undefined : {
      getOverride: (_active, _namespace, key) => dict[key], isOverrideActive: () => true,
    })
    assert.equal(preset.title, dict.presetElectronTitle, `${locale}: existing preset resolves the changed locale`)
    assert.equal(desktop.builtinTabPlugins.find(plugin => plugin.id === '@dsh-external/ego-browser').description(), dict.pluginEgoBrowserDesc)
  }
  for (const env of [{ mode: 'advanced', platform: 'darwin' }, { mode: 'advanced', platform: 'win32' },
    { mode: 'compatibility', platform: 'darwin' }, { mode: 'advanced', platform: 'linux' }]) {
    assert.equal(preset.stripFor(env), upstream.getShellPresets()[0].stripFor(env))
    assert.equal(preset.detect(env), upstream.getShellPresets()[0].detect(env))
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(desktop.builtinTabPlugins.map(({ id, install, url }) => ({ id, install, url })))),
    JSON.parse(JSON.stringify(upstream.builtinTabPlugins.map(({ id, install, url }) => ({ id, install, url })))),
  )
})
