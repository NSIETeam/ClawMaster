/** WeChat policy and Loader checks never connect to a real account. */
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as McpClient from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import * as Wechat from '../config/examples/wechat/approval.mjs'

const contexts = new Set<Context>()
const exampleDir = resolve(import.meta.dirname, '../config/examples/wechat')
const toolName = 'mcp__wechat_personal__reply_to_messages_by_chat'
afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
})

async function setup(bypass = false, serverName: Wechat.Config['serverName'] = 'wechat_personal') {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService)
  if (bypass) ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
  const policy = await ctx.plugin(Wechat, { serverName })
  let calls = 0
  for (const name of [toolName, 'mcp__wechat_official__publish_article', 'mcp__wechat_personal__unknown', 'unrelated']) {
    ctx.tools.register(defineTool({
      name, description: 'Keyless side-effect counter.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { calls++; return 'executed' },
    }))
  }
  const session = Session.create(SessionId('wechat-policy-test'))
  session.append('turn/start', { turn: 1 })
  // Only approval routing consumes this agent; no model or loop task runs here.
  const agent = { session } as unknown as Agent
  let sequence = 0
  const run = (name = toolName, signal = new AbortController().signal) => ctx.tools.execute({
    name, arguments: {}, callId: ToolCallId(`wechat-${++sequence}`), agent, signal,
  })
  return { ctx, policy, run, calls: () => calls }
}

describe('WeChat one-time approval', () => {
  it.each<ApprovalOutcome>(['allowed-once', 'rejected', 'cancelled', 'unavailable'])('handles Official Account %s before dispatch', async (outcome) => {
    const test = await setup(false, 'wechat_official')
    test.ctx.on('approval/request', async () => outcome)
    const result = await test.run('mcp__wechat_official__publish_article')
    expect(result.isError).toBe(outcome !== 'allowed-once')
    expect(test.calls()).toBe(outcome === 'allowed-once' ? 1 : 0)
  })
  it.each<ApprovalOutcome>(['allowed-once', 'rejected', 'cancelled', 'unavailable'])('handles %s before dispatch', async (outcome) => {
    const test = await setup()
    test.ctx.on('approval/request', async () => outcome)
    const result = await test.run()
    expect(result.isError).toBe(outcome !== 'allowed-once')
    expect(test.calls()).toBe(outcome === 'allowed-once' ? 1 : 0)
  })

  it('blocks when there is no answerer and leaves other namespaces alone', async () => {
    const test = await setup()
    expect((await test.run()).isError).toBe(true)
    expect(test.calls()).toBe(0)
    expect((await test.run('unrelated')).isError).toBe(false)
  })

  it('cannot be bypassed by a listener that short-circuits approval', async () => {
    const test = await setup(true)
    expect((await test.run()).isError).toBe(true)
    expect(test.calls()).toBe(0)
    await test.policy.dispose()
    expect((await test.run()).isError).toBe(false)
    expect(test.calls()).toBe(1)
  })

  it('preserves a downstream deny and blocks unknown tool names', async () => {
    const test = await setup()
    let asked = 0
    test.ctx.on('approval/request', async () => { asked++; return 'allowed-once' })
    expect((await test.run('mcp__wechat_personal__unknown')).isError).toBe(true)
    test.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'other policy' }))
    expect((await test.run()).isError).toBe(true)
    expect(asked).toBe(0)
    expect(test.calls()).toBe(0)
  })

  it('does not reuse a grant on the next call or after cancellation', async () => {
    const test = await setup()
    let asked = 0
    test.ctx.on('approval/request', async () => ++asked === 1 ? 'allowed-once' : 'rejected')
    expect((await test.run()).isError).toBe(false)
    expect((await test.run()).isError).toBe(true)
    const controller = new AbortController()
    controller.abort()
    expect((await test.run(toolName, controller.signal)).isError).toBe(true)
    expect(test.calls()).toBe(1)
    expect(asked).toBe(2)
  })
})

describe('WeChat overlay Loader composition', () => {
  it.each(['personal', 'official'])('loads %s with real MCP discovery and rejects an unreviewed tool', async (kind) => {
    const patches = loadOverlayPatches('wechat-test', resolve(exampleDir, `${kind}.cordis.yml`))
    const rows = patches[0]!.insert!
    expect(rows).toHaveLength(2)
    const guard = rows[0]!
    const client = rows[1]!
    const namespace = `wechat_${kind}`
    expect(client.config).toMatchObject({ serverName: namespace, transport: 'stdio', failOnStartupError: true, reconnect: { enabled: false } })
    expect(JSON.stringify(client.config)).toContain(kind === 'personal' ? 'wechat-mcp-server==0.2.0' : '@wenyan-md/mcp@2.0.3')
    expect(guard.name).toContain('approval.mjs')
    client.name = 'cordis:wechat-test-client'
    client.config = {
      serverName: namespace, transport: 'stdio', command: process.execPath,
      args: [resolve(import.meta.dirname, '../../../packages/mcp/mcp-client/tests/fixture-server.ts')],
      env: {}, failOnStartupError: true, reconnect: { enabled: false },
    }
    const ctx = await boot('wechat-test', resolve(import.meta.dirname, 'fixtures/memory-mcp-base.cordis.yml'), patches, (ctx) => {
      contexts.add(ctx)
      ctx.loader.builtins['memory-test-system-prompt'] = SystemPrompt
      ctx.loader.builtins['memory-test-tools'] = ToolRuntime
      ctx.loader.builtins['wechat-test-client'] = McpClient
    })
    await expect.poll(() => ctx.tools.schemas().map(tool => tool.name)).toContain(`mcp__${namespace}__greet`)
    const result = await ctx.tools.execute({
      name: `mcp__${namespace}__greet`, arguments: { name: 'fixture' },
      callId: ToolCallId('loader-test'), signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: Unsupported WeChat tool; review the integration before enabling it.' }])
  })
})
