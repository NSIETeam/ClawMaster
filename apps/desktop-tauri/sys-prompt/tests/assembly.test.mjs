/** Built DSH prompt assembly through the desktop adapter and shipped persona config. */
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const component = fileURLToPath(new URL('../', import.meta.url))
const expected = JSON.parse(await readFile(new URL('./expected/assembly.json', import.meta.url), 'utf8'))

/** Resolve built exports from their declaring package instead of root dependency hoisting. */
function owner(path) {
  return createRequire(join(repository, path, 'package.json'))
}

function load(require, name) {
  return import(pathToFileURL(require.resolve(name)).href)
}

test('desktop persona retains DSH tool guidance, schemas, variables, and live approval context', async t => {
  const promptOwner = owner('packages/core/system-prompt')
  const approvalOwner = owner('packages/interaction/user-approval')
  const cliOwner = owner('apps/cli')
  const root = await mkdtemp(join(tmpdir(), 'clawmaster prompt 空 #%-'))
  const link = join(root, 'node_modules/@deepseek-ai/dsh-system-prompt')
  let linked = false
  t.after(async () => {
    if (linked) await unlink(link)
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  await mkdir(dirname(link), { recursive: true })
  await copyFile(join(component, 'index.mjs'), join(root, 'index.mjs'))
  await copyFile(join(component, 'package.json'), join(root, 'package.json'))
  await symlink(dirname(promptOwner.resolve('@deepseek-ai/dsh-system-prompt/package.json')), link, 'junction')
  linked = true

  const [adapter, upstream, { Context }, { default: ToolRuntime }, { default: LocalFileSystem }, ToolFs,
    { default: ApprovalService, setApprovalPolicy }, { Session, SessionId }, yaml, { entryListSchema, applyEntryPatches }] = await Promise.all([
    import(pathToFileURL(join(root, 'index.mjs')).href),
    load(promptOwner, '@deepseek-ai/dsh-system-prompt'),
    load(promptOwner, '@deepseek-ai/cordis'),
    load(owner('packages/core/tools'), '@deepseek-ai/dsh-tools'),
    load(owner('packages/fs/fs-local'), '@deepseek-ai/dsh-fs-local'),
    load(owner('packages/fs/tool-fs'), '@deepseek-ai/dsh-tool-fs'),
    load(approvalOwner, '@deepseek-ai/dsh-user-approval'),
    load(approvalOwner, '@deepseek-ai/dsh-session'),
    load(cliOwner, 'js-yaml'),
    load(cliOwner, '@deepseek-ai/cordis-plugin-include'),
  ])
  assert.deepEqual(Object.keys(adapter).sort(), Object.keys(upstream).sort())
  for (const name of Object.keys(upstream)) assert.equal(adapter[name], upstream[name], name)

  const readPatches = async path => yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema })
  const [base, web, patches] = await Promise.all([
    readPatches(join(repository, 'packages/bundle/base/cordis.patch.yml')),
    readPatches(join(repository, 'packages/bundle/web-app/cordis.patch.yml')),
    readPatches(new URL('../../defaults/cordis.patch.yml', import.meta.url)),
  ])
  const manifest = JSON.parse(await readFile(join(component, 'package.json'), 'utf8'))
  const fixtureRequire = createRequire(join(root, 'package.json'))
  // Unrelated third-party targets need only entries; prompt entries come from the shipped layers.
  const externalTargets = [{ insert: [
    { id: 'openviking-memory-runtime', name: '@openviking/dsh-memory-plugin' },
    { id: 'xmanrui-dsh-im', name: '@xmanrui/dsh-im' },
  ] }]
  const profileLayers = [base, web, externalTargets]
  const desktopLayers = [...profileLayers, patches]

  function compose(layers) {
    const warnings = []
    const entries = layers.reduce((entries, layer) => applyEntryPatches(entries, structuredClone(layer),
      (...warning) => warnings.push(warning)), [])
    return { entries, warnings }
  }

  function activePromptEntries(entries) {
    return entries.filter(entry => entry.disabled !== true
      && [manifest.name, '@deepseek-ai/dsh-system-prompt'].includes(entry.name))
  }

  function productEntry(composition) {
    assert.deepEqual(composition.warnings, [])
    const active = activePromptEntries(composition.entries)
    assert.equal(active.length, 1)
    assert.equal(active[0].id, 'clawmaster-sys-prompt')
    assert.equal(active[0].name, manifest.name)
    assert.equal(composition.entries.find(entry => entry.id === 'system-prompt').disabled, true)
    return active[0]
  }

  const composed = compose(desktopLayers)
  const entry = productEntry(composed)
  const original = compose(profileLayers)
  assert.deepEqual(original.warnings, [])
  assert.equal(activePromptEntries(original.entries).length, 1)
  const originalEntry = original.entries.find(entry => entry.id === 'system-prompt')
  const { renderPrompt, renderContextSnapshot } = adapter

  async function assemble(plugin, config) {
    const ctx = new Context()
    try {
      await ctx.plugin(plugin, config)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem, { cwd: root })
      await ctx.plugin(ToolFs)
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      ctx.systemPrompt.variable('cwd', () => '/clawmaster-fixture')
      ctx.systemPrompt.variable('model', () => 'fixture-model')
      const session = Session.create(SessionId('desktop-persona-assembly'))
      // Approval context reads only the supplied Session; no agent loop or model is mounted.
      const input = { agent: { session } }
      const before = await ctx.systemPrompt.assemble(input)
      setApprovalPolicy(session, 'never')
      const after = await ctx.systemPrompt.assemble(input)
      assert.equal(renderPrompt(before), renderPrompt(after))
      return { before, after }
    } finally {
      await ctx.fiber.dispose()
    }
  }

  async function assembleEntry(entry) {
    const module = await load(fixtureRequire, entry.name)
    return assemble(module.default, entry.config)
  }

  const desktop = await assembleEntry(entry)
  const stock = await assembleEntry(originalEntry)
  const personaSections = new Set(['harness:identity', 'deployment:persona-prefix'])
  assert.deepEqual(desktop.before.sections.filter(section => !personaSections.has(section.name)),
    stock.before.sections.filter(section => !personaSections.has(section.name)))
  for (const field of ['tools', 'contexts', 'variables']) assert.deepEqual(desktop.before[field], stock.before[field], field)
  assert.match(renderPrompt(stock.before), /DeepSeek Harness/)

  function assertProductAssembly(assembly) {
    const prompt = renderPrompt(assembly)
    assert.doesNotMatch(prompt, /deepseek\s*harness/i)
    assert.ok(prompt.startsWith(`${expected.personaPrefix}\n\n`))
    assert.ok(prompt.endsWith(expected.personaSuffix))
    assert.deepEqual(assembly.sections.map(section => section.name), expected.sectionNames)
    assert.deepEqual(assembly.tools.map(tool => tool.name), expected.toolNames)
    assert.deepEqual(assembly.variables, expected.variables)
    assert.equal(renderContextSnapshot(assembly), expected.approvalAsk)
  }

  assertProductAssembly(desktop.before)
  assert.equal(renderContextSnapshot(desktop.after), expected.approvalNever)
  assert.notDeepEqual(desktop.after.contexts, desktop.before.contexts)
  assert.throws(() => assertProductAssembly(stock.before), { code: 'ERR_ASSERTION' })
  const suppressed = await assemble(adapter.default, { ...entry.config, includeRuntimeContext: false })
  assert.equal(renderContextSnapshot(suppressed.before), '')
  assert.throws(() => assertProductAssembly(suppressed.before), { code: 'ERR_ASSERTION' })

  const oldNamePatch = compose([...profileLayers, [{ id: 'system-prompt', name: manifest.name, config: entry.config }]])
  assert.equal(oldNamePatch.warnings.length, 1)
  assert.match(oldNamePatch.warnings[0][0], /name mismatch/)
  assert.deepEqual(activePromptEntries(oldNamePatch.entries), [originalEntry])
  assert.throws(() => productEntry(oldNamePatch), { code: 'ERR_ASSERTION' })

  const userConfig = { ...entry.config, personaPrefix: 'You are ClawMaster, configured by the user.' }
  const userEntry = productEntry(compose([...desktopLayers, [{ id: 'clawmaster-sys-prompt', config: userConfig }]]))
  assert.deepEqual(userEntry.config, userConfig)
  const userAssembly = await assembleEntry(userEntry)
  assert.ok(renderPrompt(userAssembly.before).startsWith(`${userConfig.personaPrefix}\n\n`))
  assert.doesNotMatch(renderPrompt(userAssembly.before), /deepseek\s*harness/i)
  assert.equal(renderContextSnapshot(userAssembly.before), expected.approvalAsk)

  const replacementConfig = { personaPrefix: 'User persona without identity settings.' }
  const replacedEntry = productEntry(compose([...desktopLayers, [{ id: 'clawmaster-sys-prompt', config: replacementConfig }]]))
  assert.deepEqual(replacedEntry.config, replacementConfig)
  assert.match(renderPrompt((await assembleEntry(replacedEntry)).before), /DeepSeek Harness/)

  const legacyConfig = { personaPrefix: 'Legacy profile persona.', includeHarnessIdentity: false }
  const legacy = compose([...desktopLayers, [{ id: 'system-prompt', config: legacyConfig }]])
  const legacyActive = productEntry(legacy)
  assert.deepEqual(legacy.entries.find(entry => entry.id === 'system-prompt').config, legacyConfig)
  assert.deepEqual(legacyActive.config, entry.config)
  assertProductAssembly((await assembleEntry(legacyActive)).before)

  const restored = compose([...desktopLayers, [
    { id: 'clawmaster-sys-prompt', disabled: true },
    { id: 'system-prompt', disabled: false },
  ]])
  assert.deepEqual(restored.warnings, [])
  const restoredActive = activePromptEntries(restored.entries)
  assert.equal(restoredActive.length, 1)
  assert.equal(restoredActive[0].id, 'system-prompt')
  assert.equal(restoredActive[0].name, '@deepseek-ai/dsh-system-prompt')
  assert.deepEqual(restoredActive[0].config, originalEntry.config)
  assert.equal(restored.entries.find(entry => entry.id === 'clawmaster-sys-prompt').disabled, true)
})
