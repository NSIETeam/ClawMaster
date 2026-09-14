/** Built DSH Session regressions for the pinned OpenViking compatibility patch. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const coreRoot = resolve(process.env.DSH_OPENVIKING_TEST_CORE_ROOT ?? repository)
const resolver = createRequire(join(coreRoot, 'apps/cli/package.json'))
const patchPath = fileURLToPath(new URL('../patches/@openviking__dsh-memory-plugin@0.3.0.patch', import.meta.url))
const integrity = JSON.parse(await readFile(new URL('../patches/openviking-0.3.0.integrity.json', import.meta.url), 'utf8'))
const sha256 = data => createHash('sha256').update(data).digest('hex')
const built = name => import(pathToFileURL(resolver.resolve(name)).href)
const { Context } = await built('@deepseek-ai/cordis')
const { default: SessionStore, Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } = await built('@deepseek-ai/dsh-session')
const { default: SessionProjections } = await built('@deepseek-ai/dsh-session-projection')
const { createUserMessage } = await built('@deepseek-ai/dsh-llm')

/** Locate the package owning a resolved entry without requiring a package.json export. */
async function packageRoot(name) {
  const dependencyResolver = name === 'zod' ? createRequire(resolver.resolve('@deepseek-ai/dsh-llm')) : resolver
  let current = dirname(dependencyResolver.resolve(name))
  while (dirname(current) !== current) {
    try {
      const manifest = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'))
      if (manifest.name === name) return current
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    current = dirname(current)
  }
  throw new Error(`Cannot locate built dependency ${name}`)
}

/** Exercise the package's recall assembler without network or a running OpenViking server. */
function memoryClient() {
  const calls = []
  return {
    calls,
    async healthResult() { return { ok: true } },
    async ensureSessionResult() { return { ok: true } },
    async fetchJSON(path, init = {}) {
      calls.push({ path, method: init.method ?? 'GET' })
      if (path.startsWith('/api/v1/content/read')) return { ok: true, result: 'User prefers concise reports.' }
      if (path === '/api/v1/search/search') return { ok: true, result: {
        rendered: 'The fixture customer prefers email.',
        entries: [{ uri: 'viking://~/memories/fixture.md', category: 'memory', score: 1, text: 'The fixture customer prefers email.' }],
      } }
      return { ok: true, result: [] }
    },
    async getSession() { return { pending_tokens: 1000000 } },
    async commitSession() { calls.push({ method: 'POST', path: '/commit' }); return { ok: true } },
  }
}

test('OpenViking 0.3.0 preserves rc2 replay, fork and request-series behavior', { concurrency: false }, async t => {
  const pristine = process.env.DSH_OPENVIKING_PRISTINE
  assert.ok(pristine, 'Set DSH_OPENVIKING_PRISTINE to the extracted, unmodified official 0.3.0 package; build the DSH CLI dependencies first.')
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-openviking-compat-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const environment = {
    HOME: join(root, 'home'),
    OPENVIKING_PENDING_DIR: join(root, 'pending'),
    OPENVIKING_CLI_CONFIG_FILE: join(root, 'missing-cli.conf'),
    OPENVIKING_CONFIG_FILE: join(root, 'missing-server.conf'),
    OPENVIKING_CREDENTIAL_SOURCE: 'env',
  }
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]))
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  Object.assign(process.env, environment)

  for (const [name, expected] of Object.entries(integrity.upstreamSha256)) {
    assert.equal(sha256(await readFile(join(pristine, name))), expected, `Unreviewed upstream file: ${name}`)
  }
  assert.equal(sha256(await readFile(patchPath)), integrity.patchSha256, 'Unreviewed compatibility patch')
  const manifest = JSON.parse(await readFile(join(pristine, 'package.json'), 'utf8'))
  assert.equal(manifest.name, integrity.package)
  assert.equal(manifest.version, integrity.version)
  const original = join(root, 'original')
  const patched = join(root, 'patched')
  await cp(pristine, original, { recursive: true })
  await cp(pristine, patched, { recursive: true })
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-skill-filesystem', 'zod']) {
    const target = join(root, 'node_modules', name)
    await mkdir(dirname(target), { recursive: true })
    await symlink(await packageRoot(name), target, 'junction')
  }
  const applied = spawnSync('git', ['apply', '--check', patchPath], { cwd: patched, encoding: 'utf8', timeout: 10000 })
  assert.equal(applied.error, undefined)
  assert.equal(applied.signal, null)
  assert.equal(applied.status, 0, applied.stderr)
  const written = spawnSync('git', ['apply', patchPath], { cwd: patched, encoding: 'utf8', timeout: 10000 })
  assert.equal(written.error, undefined)
  assert.equal(written.signal, null)
  assert.equal(written.status, 0, written.stderr)
  for (const [name, expected] of Object.entries(integrity.patchedSha256)) {
    assert.equal(sha256(await readFile(join(patched, name))), expected, `Unexpected patch output: ${name}`)
  }
  const moduleAt = (directory, name) => import(pathToFileURL(join(directory, name)).href)
  const [plugin, runtimeModule, upstreamRuntime, upstreamPlugin, configuration, pending] = await Promise.all([
    moduleAt(patched, 'index.mjs'), moduleAt(patched, 'runtime.mjs'),
    moduleAt(original, 'runtime.mjs'), moduleAt(original, 'index.mjs'),
    moduleAt(patched, 'config.mjs'), moduleAt(patched, 'shared/pending-queue.mjs'),
  ])
  const config = configuration.resolveConfig({ endpoint: 'http://127.0.0.1:1933', syncTurns: false }, environment, root)
  const ctx = new Context()
  const fibers = []
  const toolFibers = []
  t.after(async () => {
    for (const fiber of toolFibers.reverse()) await fiber.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(SessionProjections))
  const unregister = ctx.sessionProjections.register(runtimeModule.startupProfileProjection)
  t.after(unregister)
  const message = createUserMessage({ content: [{ type: 'text', text: 'Remembered profile fixture' }],
    source: { kind: 'plugin', plugin: 'openviking-memory', form: 'instructions' } })
  const agentFor = session => ({ session, inbox: { nextTurn: [], nextStep: [] } })
  const runtimeFor = (Runtime = runtimeModule.OpenVikingRuntime) => new Runtime(memoryClient(), config, { debug() {} }, ctx.sessionProjections)

  await t.test('committed profile survives JSON log restoration and suppresses another injection', async () => {
    const live = ctx.sessions.create()
    const first = runtimeFor()
    const injected = await first.profileMessage(agentFor(live))
    assert.equal(injected.source.form, 'instructions')
    live.append('user/message', injected, { surfaceOp: 'append' })
    const wireEvents = JSON.parse(JSON.stringify(live.snapshotEvents()))
    const restored = Session.create(live.id, wireEvents)
    assert.equal(await runtimeFor().profileMessage(agentFor(restored)), null)
    assert.equal(await runtimeFor().profileMessage(agentFor(live)), null)
    assert.notEqual(await runtimeFor(upstreamRuntime.OpenVikingRuntime).profileMessage(agentFor(restored)), null,
      'Negative control: official 0.3.0 must reproduce the missing session.events regression')
  })

  await t.test('fork inherits no profile-delivered state until its own profile is committed', async () => {
    const parent = Session.create(SessionId('openviking-parent'))
    parent.append('user/message', message, { surfaceOp: 'append' })
    const inherited = parent.snapshotEvents()
    const childId = SessionId('openviking-child')
    const child = Session.create(childId, inherited, {
      version: SESSION_FORMAT_VERSION, id: childId, createdAt: 0, isSeeded: true,
    }, SessionLogOffset(inherited.length))
    const profile = await runtimeFor().profileMessage(agentFor(child))
    assert.notEqual(profile, null)
    child.append('user/message', profile, { surfaceOp: 'append' })
    assert.equal(await runtimeFor().profileMessage(agentFor(child)), null)
  })

  await t.test('queued instructions suppress duplicates while recall messages do not', async () => {
    for (const queue of ['nextTurn', 'nextStep']) {
      const agent = agentFor(Session.create(SessionId(`queued-${queue}`)))
      agent.inbox[queue].push(message)
      assert.equal(await runtimeFor().profileMessage(agent), null)
    }
    const session = Session.create(SessionId('recall-only'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Recall fixture' }],
      source: { kind: 'plugin', plugin: 'openviking-memory', form: 'recall' } }), { surfaceOp: 'append' })
    assert.notEqual(await runtimeFor().profileMessage(agentFor(session)), null)
  })

  /** Capture the published plugin's hook registrations; MCP transport remains outside this unit fixture. */
  async function hooksFor(implementation, parent = ctx) {
    const hooks = new Map()
    let runtime
    const fiber = parent.isolate('openvikingMemory').plugin({
      name: 'openviking-hook-fixture',
      inject: ['sessionProjections'],
      async apply(owner) {
        await implementation.apply({
          sessionProjections: owner.sessionProjections, logger: { debug() {} },
          provide(name, value) { runtime = value; runtime.client = memoryClient(); owner.provide(name, value) },
          effect: owner.effect.bind(owner),
          on(name, handler) { hooks.set(name, handler); return owner.on(name, handler) },
          plugin(child, childConfig) {
            if (child.name === 'openviking-profile-state') return owner.plugin(child, childConfig)
          },
        }, config)
      },
    })
    toolFibers.push(fiber)
    await fiber.await()
    return { hooks, runtime, fiber }
  }

  await t.test('profile and synthetic recall preserve request-series flags and source-attributed messages', async () => {
    const input = createUserMessage({ content: [{ type: 'text', text: 'How should we contact the fixture customer?' }], source: { kind: 'user' } })
    const originalDecision = { kind: 'enter', messages: [input], startsRequestSeries: true }
    for (const [implementation, fixed] of [[plugin, true], [upstreamPlugin, false]]) {
      const { hooks } = await hooksFor(implementation)
      const session = Session.create(SessionId(fixed ? 'fixed-hook' : 'upstream-hook'))
      const result = await hooks.get('agent/pre-step')({ agent: agentFor(session), messages: [input], signal: new AbortController().signal },
        async () => originalDecision)
      assert.equal(result.startsRequestSeries, fixed ? true : undefined)
      assert.equal(result.messages[0], input)
      assert.deepEqual(result.messages.slice(1).map(item => item.source.form), ['instructions', 'recall'])
      for (const item of result.messages) session.append('user/message', item, { surfaceOp: 'append' })
      const replayed = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())))
      assert.deepEqual(replayed.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data), result.messages)
    }
    assert.equal(originalDecision.messages.length, 1)
  })

  await t.test('rejected and cancelled steps retain the downstream decision without recall work', async () => {
    const { hooks, runtime } = await hooksFor(plugin)
    runtime.profileMessage = async () => { throw new Error('Unexpected memory request') }
    const hook = hooks.get('agent/pre-step')
    const agent = agentFor(Session.create(SessionId('cancelled-hook')))
    const reject = { kind: 'reject' }
    assert.equal(await hook({ agent, signal: new AbortController().signal }, async () => reject), reject)
    const enter = { kind: 'enter', messages: [], startsRequestSeries: true }
    assert.equal(await hook({ agent, signal: AbortSignal.abort() }, async () => enter), enter)
  })

  await t.test('syncTurns false retains upstream pending replay and commit semantics', async () => {
    await pending.enqueue('addMessage', 'fixture-existing-pending', { role: 'user', parts: [{ type: 'text', text: 'Only fixture data' }] })
    const session = Session.create(SessionId('sync-disabled'))
    const runtime = runtimeFor()
    await runtime.initialize(agentFor(session))
    runtime.capture(session, { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'Do not capture this new message' }], source: { kind: 'user' } }) })
    runtime.maybeCommit(session, { type: 'turn/end' })
    await runtime.flush(session)
    await runtime.dispose(session)
    assert.equal(runtime.client.calls.filter(call => call.path.endsWith('/messages')).length, 1)
    assert.equal(runtime.client.calls.filter(call => call.path === '/commit').length, 2)
  })

  await t.test('a cancelled recall does not mark an uncommitted profile as delivered', async () => {
    for (const [implementation, fixed] of [[plugin, true], [upstreamPlugin, false]]) {
      const { hooks, runtime } = await hooksFor(implementation)
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const fetchJSON = runtime.client.fetchJSON.bind(runtime.client)
      runtime.client.fetchJSON = async (path, init) => {
        if (path === '/api/v1/search/search') { entered.resolve(); await release.promise }
        return fetchJSON(path, init)
      }
      const agent = agentFor(Session.create(SessionId(fixed ? 'cancel-fixed' : 'cancel-upstream')))
      const input = createUserMessage({ content: [{ type: 'text', text: 'Recall fixture contact details' }], source: { kind: 'user' } })
      const decision = { kind: 'enter', messages: [input], startsRequestSeries: true }
      const controller = new AbortController()
      const hook = hooks.get('agent/pre-step')
      const pending = hook({ agent, signal: controller.signal }, async () => decision)
      try {
        await entered.promise
        controller.abort()
      } finally { release.resolve() }
      assert.equal(await pending, decision)
      const retried = await hook({ agent, signal: new AbortController().signal }, async () => decision)
      assert.equal(retried.messages.some(item => item.source?.form === 'instructions'), fixed,
        'Negative control: upstream marks the discarded profile delivered before recall settles')
    }
  })

  await t.test('claimed startup profile is not duplicated before the loop commits it', async () => {
    const { hooks } = await hooksFor(plugin)
    const agent = agentFor(Session.create(SessionId('claimed-profile')))
    const decision = { kind: 'enter', messages: [message] }
    const result = await hooks.get('agent/pre-step')({ agent, signal: new AbortController().signal }, async () => decision)
    assert.equal(result.messages.filter(item => item.source?.form === 'instructions').length, 1)
  })

  await t.test('unload drains in-flight initialization before withdrawing its projection', { timeout: 10000 }, async () => {
    const parent = new Context()
    const storeFiber = await parent.plugin(SessionStore)
    const projectionFiber = await parent.plugin(SessionProjections)
    const { hooks, runtime, fiber } = await hooksFor(plugin, parent)
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const closingStarted = Promise.withResolvers()
    fiber.ctx.effect(() => () => closingStarted.resolve())
    runtime.client.healthResult = async () => { entered.resolve(); await release.promise; return { ok: true } }
    const agent = agentFor(Session.create(SessionId('unload-initialize')))
    const decision = { kind: 'enter', messages: [] }
    const pending = hooks.get('agent/pre-step')({ agent, signal: new AbortController().signal }, async () => decision)
    let disposed = false
    let disposal
    try {
      await entered.promise
      disposal = fiber.dispose().then(() => { disposed = true })
      await closingStarted.promise
      assert.equal(disposed, false)
      assert.notEqual(parent.sessionProjections.stateOf(agent.session, 'openviking/startup-profile'), undefined)
      const afterClosing = await hooks.get('agent/pre-step')({ agent, signal: new AbortController().signal }, async () => decision)
      assert.equal(afterClosing, decision)
    } finally { release.resolve() }
    try {
      assert.equal(await pending, decision)
      await disposal
      assert.equal(parent.sessionProjections.stateOf(agent.session, 'openviking/startup-profile'), undefined)
      assert.equal(runtime.states.size, 0)
    } finally {
      await fiber.dispose()
      await projectionFiber.dispose()
      await storeFiber.dispose()
    }
  })
})
