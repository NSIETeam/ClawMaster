/** Built-profile acceptance: mounts the complete npm preset through DSH's real preset selector. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const coreRoot = resolve(process.env.DSH_ROUTING_TEST_CORE_ROOT ?? join(repository, 'apps/desktop-tauri/bundled/harness'))
const resolver = createRequire(join(coreRoot, 'apps/cli/package.json'))
const packageRoot = process.env.DSH_ROUTING_TEST_PACKAGE_ROOT
  ? resolve(process.env.DSH_ROUTING_TEST_PACKAGE_ROOT)
  : resolve(dirname(resolver.resolve('dsh-routing-suite')), '..')
const patch = fileURLToPath(new URL('../patches/dsh-routing-suite@0.1.2.patch', import.meta.url))

/** The temporary Host plugin only adds a fixture adapter and an authenticated acceptance route. */
function probeSource() {
  return `import { LlmAdapter, createUserMessage } from ${JSON.stringify(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-llm')).href)};
const requests = [];
class FixtureAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(request) {
    requests.push({ provider: request.provider, model: request.model,
      tools: request.tools?.map(tool => tool.name) ?? [],
      system: request.messages.filter(message => message.role === 'system').flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text)).join('\\n') });
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'ROUTING_PRESET_DONE' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ROUTING_PRESET_DONE' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export const name = 'routing-preset-acceptance';
export const inject = ['llm', 'tools', 'agents', 'sessionController', 'agentPresets', 'sessionProjections', 'sessionPersistence', 'connection'];
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['routing-fixture'], new FixtureAdapter()));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/clawmaster/routing-preset-probe', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    const { preset, task } = await request.json();
    const created = await ctx.sessionController.create({ cwd: process.env.ROUTING_FIXTURE_CWD });
    const agent = ctx.agents.get(created.sessionId);
    const before = requests.length;
    try { await ctx.agentPresets.select(agent, preset); }
    catch (error) { return Response.json({ selected: false, error: String(error) }); }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }));
    await agent.whenIdle();
    await ctx.sessionPersistence.flush();
    const reader = await ctx.sessionPersistence.open(agent.session.id, 'read');
    let events;
    try { events = (await reader.read()).events; }
    finally { await reader.close(); }
    return Response.json({ selected: true, headerPreset: agent.session.header.agentPreset,
      selectedPreset: ctx.sessionProjections.stateOf(agent.session, 'agentPreset'),
      requests: requests.slice(before),
      tools: ctx.tools.schemas(agent).map(tool => tool.name),
      events: events.filter(event => ['agent-preset/selected', 'system/message', 'assistant/message', 'turn/end'].includes(event.type)) });
  } }));
}
`
}

/** Wait for an owned observation while keeping timeout and completion separate. */
async function deadline(promise, milliseconds, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

test('the complete routing preset loads, selects and supplies the first real AgentLoop request', { timeout: 180000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'clawmaster-routing-preset-'))
  let finishHost = async () => {}
  t.after(async () => {
    await finishHost()
    await rm(fixture, { recursive: true, force: true, maxRetries: 3 })
  })
  const home = join(fixture, 'dsh')
  const osHome = join(fixture, 'home')
  const cwd = join(fixture, 'workspace')
  await mkdir(osHome)
  await mkdir(cwd)
  const { prepareDesktopProfile } = await import(pathToFileURL(join(coreRoot, 'desktop-defaults.mjs')).href)
  await prepareDesktopProfile(coreRoot, home)
  const presetRoot = join(home, '.agent-presets')
  await cp(join(packageRoot, 'preset/routing-suite'), join(presetRoot, 'routing-suite'), { recursive: true })

  const upstream = join(fixture, 'upstream')
  await cp(packageRoot, upstream, { recursive: true })
  const reversed = spawnSync('git', ['apply', '--reverse', patch], { cwd: upstream, encoding: 'utf8', timeout: 10000 })
  assert.equal(reversed.error, undefined)
  assert.equal(reversed.signal, null)
  assert.equal(reversed.status, 0, reversed.stderr)
  await cp(join(upstream, 'preset/routing-suite'), join(presetRoot, 'routing-suite-upstream'), { recursive: true })
  const profile = join(home, 'profiles/web')
  await writeFile(join(profile, 'routing-probe.mjs'), probeSource())
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: agent-default-model\n  config:\n    provider: routing-fixture\n    model: fixture\n- insert:\n    - id: routing-preset-acceptance\n      name: './routing-probe.mjs'\n`)
  const child = spawn(process.execPath, [join(coreRoot, 'apps/cli/lib/bin.js'), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: coreRoot, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', HOME: osHome,
      XDG_CONFIG_HOME: join(fixture, 'xdg'), DSH_HOME: home, DSH_AGENTS_HOME: join(osHome, '.agents'),
      ROUTING_FIXTURE_CWD: cwd, NODE_ENV: 'production', DSH_TELEMETRY_DISABLED: '1' },
    detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let stderr = ''
  let closed = false
  let ready
  const startup = new Promise(resolve => { ready = resolve })
  child.stdout.on('data', chunk => {
    output += chunk
    const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)
    if (match) ready(match[1])
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { closed = true; resolve({ code, signal }) })
  })
  const stop = signal => {
    if (closed) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  finishHost = async () => {
    stop('SIGTERM')
    const force = setTimeout(() => stop('SIGKILL'), 5000)
    try { await deadline(done, 10000, 'Routing profile Host did not close') }
    finally { clearTimeout(force) }
  }
  const url = await deadline(Promise.race([startup, done.then(exit => {
    throw new Error(`Routing profile startup failed (${exit.code}, ${exit.signal}): ${stderr}`)
  })]), 60000, 'Routing profile startup timed out')
  const exchange = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.get('set-cookie').split(';')[0]
  const base = new URL('/', url)
  const run = async preset => {
    const response = await fetch(new URL('/api/clawmaster/routing-preset-probe', base), {
      method: 'POST', headers: { cookie, origin: base.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ preset, task: '排查并修复登录失败' }), signal: AbortSignal.timeout(30000),
    })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  const original = await run('routing-suite-upstream')
  assert.equal(original.selected, false)
  assert.match(original.error, /persona.*prefix|prefix.*required/s)
  const fixed = await run('routing-suite')
  assert.equal(fixed.selected, true, fixed.error)
  assert.equal(fixed.headerPreset, 'standard')
  assert.equal(fixed.selectedPreset, 'routing-suite')
  const model = fixed.requests.find(request => request.tools.length > 0)
  assert.ok(model, 'The selected complete preset must reach a model request with its tools')
  assert.match(model.system, /maintenance or investigation/)
  assert.match(model.system, /working directory is/)
  assert.ok(fixed.tools.includes('subagent'))
  assert.ok(fixed.events.some(event => event.type === 'agent-preset/selected' && event.data.agentPreset === 'routing-suite'))
  assert.ok(fixed.events.some(event => event.type === 'system/message' && event.data.message.content.some(part => part.type === 'text' && part.text.includes('maintenance or investigation'))))
  assert.ok(fixed.events.some(event => event.type === 'assistant/message'))
  assert.equal(fixed.events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
})
