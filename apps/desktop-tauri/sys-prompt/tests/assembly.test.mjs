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
    { default: ApprovalService, setApprovalPolicy }, { Session, SessionId }, yaml, { entryListSchema }] = await Promise.all([
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

  const patches = yaml.load(await readFile(new URL('../../defaults/cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
  const entry = patches.find(candidate => candidate.id === 'system-prompt')
  const manifest = JSON.parse(await readFile(join(component, 'package.json'), 'utf8'))
  assert.equal(entry.name, manifest.name)
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

  const desktop = await assemble(adapter.default, entry.config)
  const stock = await assemble(upstream.default, { ...entry.config, includeHarnessIdentity: true, personaPrefix: '' })
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
})
