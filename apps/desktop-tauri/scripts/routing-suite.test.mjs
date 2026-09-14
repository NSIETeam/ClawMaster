/** Artifact test: requires a built DSH tree and the patched npm routing package. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const bundledRoot = resolve(repository, 'apps/desktop-tauri/bundled/harness')
const coreRoot = resolve(process.env.DSH_ROUTING_TEST_CORE_ROOT ?? (existsSync(resolve(bundledRoot, 'apps/cli/package.json')) ? bundledRoot : repository))
const core = path => import(pathToFileURL(resolve(coreRoot, path)).href)
const { Context } = await core('vendor/cordis/lib/index.js')
const { default: SessionStore } = await core('packages/core/session/lib/index.js')
const { default: SessionProjections } = await core('packages/session/session-projection/lib/index.js')
const { default: SystemPrompt } = await core('packages/core/system-prompt/lib/index.js')
const { default: LlmRuntime, LlmAdapter, createUserMessage } = await core('packages/llm/llm/lib/index.js')
const { default: ToolRuntime } = await core('packages/core/tools/lib/index.js')
const { default: AgentRegistry } = await core('packages/core/agent/lib/index.js')
const { default: AgentLoop } = await core('packages/core/agent-loop/lib/index.js')
const resolveDesktop = createRequire(resolve(coreRoot, 'apps/cli/package.json'))
const pluginFile = process.env.DSH_ROUTING_TEST_PACKAGE_ROOT
  ? resolve(process.env.DSH_ROUTING_TEST_PACKAGE_ROOT, 'lib/index.js')
  : resolveDesktop.resolve('dsh-routing-suite')
const routing = await import(pathToFileURL(pluginFile).href)
const projectionKey = 'routing-suite/task'
const sectionName = 'routing-suite-guidance'

/** Real Session and prompt services; the unused HTTP listener is an in-memory registry. */
async function harness(t, config = {}, beforeMount) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const routes = new Set()
  ctx.provide('webServer', { register(route) {
    routes.add(route)
    return () => routes.delete(route)
  } })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await beforeMount?.(ctx)
  const mount = () => ctx.plugin(routing, { enabled: true, strategy: 'auto', ...config })
  const plugin = mount()
  await plugin
  const create = preset => ctx.sessions.create(undefined, { meta: { agentPreset: preset } })
  const assemble = session => ctx.systemPrompt.assemble({ agent: { session } })
  return { ctx, routes, plugin, mount, create, assemble }
}

function message(session, text, source = { kind: 'user' }) {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' })
}

const guidance = assembly => assembly.sections.filter(section => section.name === sectionName)

/** Capture actual loop requests without opening a provider connection. */
async function loopHarness(t) {
  const h = await harness(t)
  await h.ctx.plugin(LlmRuntime)
  await h.ctx.plugin(ToolRuntime)
  await h.ctx.plugin(AgentRegistry)
  await h.ctx.plugin(AgentLoop, { agents: [] })
  const requests = []
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      requests.push(request)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Done.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  h.ctx.llm.registerAdapter(['fixture'], new FixtureAdapter())
  const agent = await h.ctx.agentLoop.create('routing-loop-fixture', { provider: 'fixture', model: 'fixture' })
  agent.session.append('agent-preset/selected', { agentPreset: 'routing-suite' })
  const send = async text => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  return { ...h, agent, send, requests }
}

const requestSystem = request => request?.messages.filter(message => message.role === 'system')
  .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text)).join('\n') ?? ''

test('the first real loop request routes before its user message is committed', { timeout: 5000 }, async t => {
  const h = await loopHarness(t)
  await h.send('排查并修复登录失败')
  assert.equal(h.requests.length, 1)
  assert.match(requestSystem(h.requests[0]), /maintenance or investigation/)
  const events = h.agent.session.snapshotEvents()
  const user = events.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'user')
  const system = events.findIndex(event => event.type === 'system/message')
  assert.ok(system >= 0 && system < user)
  assert.match(events[system].data.message.content[0].text, /maintenance or investigation/)
  await h.send('创建下一项')
  assert.equal(h.requests.length, 2)
  assert.match(requestSystem(h.requests[1]), /maintenance or investigation/)
})

test('a rejected uncommitted turn does not choose the next turn routing', { timeout: 5000 }, async t => {
  const h = await loopHarness(t)
  const remove = h.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
  await h.send('debug a failure')
  assert.equal(h.requests.length, 0)
  remove()
  await h.send('create a report')
  assert.equal(h.requests.length, 1)
  assert.match(requestSystem(h.requests[0]), /creation or implementation/)
})

test('auto routing classifies the first real user task on a current Session', async t => {
  const h = await harness(t)
  const inspect = h.create('routing-suite')
  assert.equal('events' in inspect, false)
  message(inspect, '新建一个页面', { kind: 'plugin', plugin: 'fixture-context' })
  message(inspect, '   ')
  message(inspect, '排查并修复登录失败')
  const inspected = await h.assemble(inspect)
  assert.match(guidance(inspected)[0]?.text ?? '', /maintenance or investigation/)
  message(inspect, '创建下一项')
  assert.deepEqual(guidance(await h.assemble(inspect)), guidance(inspected))

  const direct = h.create('routing-suite')
  message(direct, '创建一个企业协作页面')
  assert.match(guidance(await h.assemble(direct))[0]?.text ?? '', /creation or implementation/)
  assert.equal(guidance(await h.assemble(direct)).length, 1)
})

test('routing reconstructs a selected preset and task when mounted after their events', async t => {
  let session
  const h = await harness(t, {}, ctx => {
    session = ctx.sessions.create(undefined, { meta: { agentPreset: 'standard' } })
    session.append('agent-preset/selected', { agentPreset: 'routing-suite' })
    message(session, 'Debug the failed import')
  })
  assert.equal(routing.selectedPreset(session, h.ctx.sessionProjections), 'routing-suite')
  assert.match(guidance(await h.assemble(session))[0]?.text ?? '', /maintenance or investigation/)
  const restored = h.ctx.sessions.create(undefined, {
    seed: structuredClone(session.snapshotEvents()),
    meta: { agentPreset: 'standard' },
  })
  assert.deepEqual(guidance(await h.assemble(restored)), guidance(await h.assemble(session)))
})

test('live preset selection and other Sessions remain independent', async t => {
  const h = await harness(t)
  const session = h.create('standard')
  message(session, 'implement a report')
  assert.deepEqual(guidance(await h.assemble(session)), [])
  session.append('agent-preset/selected', { agentPreset: 'routing-suite' })
  assert.match(guidance(await h.assemble(session))[0]?.text ?? '', /creation or implementation/)
  session.append('agent-preset/selected', { agentPreset: 'standard' })
  assert.deepEqual(guidance(await h.assemble(session)), [])
  assert.deepEqual(guidance(await h.assemble(h.create('routing-suite'))), [])
})

test('disabled and neutral routing preserve the assembled prompt', async t => {
  for (const [enabled, text] of [[false, 'fix the error'], [true, 'hello']]) {
    await t.test(`${enabled ? 'neutral' : 'disabled'} task`, async t => {
      const h = await harness(t, { enabled })
      h.ctx.systemPrompt.section({ name: 'fixture-rule', order: 1, text: 'Keep this rule.' })
      const session = h.create('routing-suite')
      message(session, text)
      const baseline = await h.ctx.systemPrompt.assemble()
      assert.deepEqual(await h.assemble(session), baseline)
    })
  }
})

test('fixed strategies retain the plugin override and preserve non-routing sections', async t => {
  const h = await harness(t, { strategy: 'inspect-first' })
  h.ctx.systemPrompt.section({ name: 'fixture-rule', order: 1, text: 'Keep this rule.' })
  const session = h.create('routing-suite')
  message(session, 'create a page')
  const baseline = await h.ctx.systemPrompt.assemble()
  const assembled = await h.assemble(session)
  assert.match(guidance(assembled)[0]?.text ?? '', /maintenance or investigation/)
  assert.deepEqual({ ...assembled, sections: assembled.sections.filter(section => section.name !== sectionName) }, baseline)
})

test('unload removes the projection, middleware and route; reloading reconstructs state', async t => {
  const h = await harness(t)
  const session = h.create('routing-suite')
  message(session, 'fix the import')
  const before = guidance(await h.assemble(session))
  assert.equal(before.length, 1)
  assert.equal(h.routes.size, 1)
  await h.plugin.dispose()
  assert.equal(h.routes.size, 0)
  assert.deepEqual(guidance(await h.assemble(session)), [])
  assert.equal(h.ctx.sessionProjections.stateOf(session, projectionKey), undefined)
  await h.mount()
  assert.deepEqual(guidance(await h.assemble(session)), before)
})

test('an assembly waiting downstream does not read the projection after plugin unload', async t => {
  const h = await harness(t)
  const session = h.create('routing-suite')
  message(session, 'fix the import')
  let enter
  let release
  const entered = new Promise(resolve => { enter = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    enter()
    await barrier
    return next()
  })
  const assembly = h.assemble(session)
  await entered
  try {
    await h.plugin.dispose()
  } finally {
    release()
  }
  assert.deepEqual(guidance(await assembly), [])
})

test('patched runtime reads the public projection instead of synchronous Session history', async () => {
  const source = await readFile(pluginFile, 'utf8')
  assert.doesNotMatch(source, /session\??\.(?:events|snapshotEvents|eventAt|ownEvents)/)
  assert.match(source, /sessionProjections\.register\(routingProjection\)/)
})

test('installed routing bytes match the reviewed compatibility patch', async () => {
  const directory = new URL('../patches/', import.meta.url)
  const provenance = JSON.parse(await readFile(new URL('dsh-routing-suite@0.1.2.provenance.json', directory), 'utf8'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  assert.equal(hash(await readFile(new URL(provenance.patch, directory))), provenance.patchSha256)
  const packageRoot = resolve(dirname(pluginFile), '..')
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, provenance.package)
  assert.equal(manifest.version, provenance.version)
  for (const [path, expected] of Object.entries(provenance.patchedSha256)) {
    assert.equal(hash(await readFile(resolve(packageRoot, path))), expected, `Unreviewed runtime: ${path}`)
  }
})
