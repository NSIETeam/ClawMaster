/** Keyless real-Loader/AgentLoop recording and storage replay; only the model is scripted. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '../../../vendor/cordis/src/index.ts';
import Loader from '../../../vendor/loader/src/index.ts';
import Include from '../../../vendor/include/src/index.ts';
import LlmRuntime, { createUserMessage } from '../../../packages/llm/llm/src/index.ts';
import SessionStore, { Session, SessionId } from '../../../packages/core/session/src/index.ts';
import SessionProjections from '../../../packages/session/session-projection/src/index.ts';
import SystemPrompt from '../../../packages/core/system-prompt/src/index.ts';
import ToolRuntime, { defineTool } from '../../../packages/core/tools/src/index.ts';
import AgentRegistry from '../../../packages/core/agent/src/index.ts';
import AgentLoop from '../../../packages/core/agent-loop/src/index.ts';
import ApprovalService from '../../../packages/interaction/user-approval/src/index.ts';
import SandboxPolicy from '../../../packages/sandbox/sandbox-policy/src/index.ts';
import SandboxedFileSystem from '../../../packages/fs/fs-sandbox/src/index.ts';
import * as ObservationPolicy from '../../../packages/fs/fs-observation-policy/src/index.ts';
import JsonlPersistence from '../../../packages/session/session-persistence-jsonl/src/index.ts';
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts';
import { applyDataTools } from '../src/data-tools.ts';
import { applyEnterpriseTools } from '../src/enterprise-tools.ts';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { applyRuntimeGovernance } from '../src/runtime-governance.ts';
import { mountWatchdogTasks } from '../src/watchdog-task-host.ts';
import { GovernanceAccess } from '../src/governance-access.ts';
import { LOCAL_HTTP_IDENTITY } from '../src/governance-audit.ts';
import * as Guard from '../../guard/src/index.ts';

const contact = { id: 'synthetic-lead', name: 'Synthetic Customer', company: 'Fixture Company', stage: 'lead', nextAction: 'Review synthetic lead', nextActionDate: null };

async function fixture(t, script, runtime = false, tasks = false) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-business-flow-'));
  const ctx = new Context();
  if (runtime) {
    const previous = process.env.CLAWMASTER_RUNTIME_STATE;
    const previousRun = process.env.CLAWMASTER_RUNTIME_RUN_ID;
    process.env.CLAWMASTER_RUNTIME_STATE = join(root, 'current-runtime.json');
    process.env.CLAWMASTER_RUNTIME_RUN_ID = 'fixture-run';
    t.after(() => {
      if (previous === undefined) delete process.env.CLAWMASTER_RUNTIME_STATE;
      else process.env.CLAWMASTER_RUNTIME_STATE = previous;
      if (previousRun === undefined) delete process.env.CLAWMASTER_RUNTIME_RUN_ID;
      else process.env.CLAWMASTER_RUNTIME_RUN_ID = previousRun;
    });
    await writeFile(process.env.CLAWMASTER_RUNTIME_STATE, JSON.stringify({
      schemaVersion: 1, status: 'ready', runId: 'fixture-run', hostPid: process.pid, port: 17890,
      observedAtUnixMs: 1, desktopVersion: 'fixture', harnessVersion: 'fixture',
      contentSha256: 'a'.repeat(64), harnessRoot: root, disabledPlugins: [], buildProvenance: null,
    }));
  }
  let store;
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { store?.close(); await rm(root, { recursive: true, force: true }); }
  });
  store = await openEnterpriseStore(join(root, 'enterprise.sqlite'));
  const adapter = new MockAdapter(script);
  const product = {
    name: 'business-tools-fixture', inject: ['tools', 'approval', 'fs', 'sandboxPolicy', 'systemPrompt'],
    async apply(context) {
      applyDataTools(context);
      if (runtime) applyRuntimeGovernance(context);
      const remove = await applyEnterpriseTools(context, store);
      context.effect(() => remove);
      if (tasks) {
        const removeTasks = await mountWatchdogTasks({ tools: context.tools, approval: context.approval,
          connection: { fetch: { register() { return async () => {}; } } } }, store, new GovernanceAccess());
        context.effect(() => removeTasks);
      }
    },
  };
  const entries = [
    ['llm', LlmRuntime], ['sessions', SessionStore], ['projections', SessionProjections],
    ['prompt', SystemPrompt], ['tools', ToolRuntime, { mode: 'native' }],
    ['agents', AgentRegistry], ['persistence', JsonlPersistence, { root: join(root, 'sessions') }],
    ['approval', ApprovalService, { policy: 'ask' }],
    ['sandbox-policy', SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root }],
    ['fs', SandboxedFileSystem, { cwd: root }], ['fs-observation', ObservationPolicy],
    ['loop', AgentLoop, { agents: [] }], ['business-tools', product],
  ];
  const configPath = join(root, 'cordis.yml');
  await writeFile(configPath, JSON.stringify(entries.map(([name, , config]) => ({ name, ...(config ? { config } : {}) }))));
  ctx.baseUrl = pathToFileURL(root).href + '/';
  await ctx.plugin(Loader).await();
  ctx.loader.builtins.include = Include;
  const modules = new Map(entries.map(([name, plugin]) => [name, plugin]));
  ctx.loader.internal = {
    version: 'v2',
    async import(name) {
      if (!modules.has(name)) throw new Error(`Unexpected fixture plugin ${name}`);
      return modules.get(name);
    },
  };
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } });
  await ctx.loader.await();
  ctx.llm.registerAdapter(['mock'], adapter);
  const agent = await ctx.agentLoop.create(SessionId('business-flow'), { provider: 'mock', model: 'mock' }, { cwd: root });
  const run = async () => {
    const idle = new Promise(resolve => {
      const remove = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { remove(); resolve(); }
      });
    });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Process only the synthetic fixture data.' }], source: { kind: 'user' } }));
    await idle;
    await ctx.sessionPersistence.flush();
    const reader = await ctx.sessionPersistence.open(agent.id, 'read');
    try {
      const { events } = await reader.read(0, 1000);
      assert.equal(events.at(-1).type, 'turn/end');
      assert.deepEqual(events.at(-1).data.reason, { kind: 'completed' });
      const replay = Session.create(agent.id, events, reader.meta, reader.inheritedEventCount);
      assert.deepEqual(replay.deriveMessages(), agent.session.deriveMessages());
      const calls = events.filter(event => event.type === 'tool/call');
      const results = events.filter(event => event.type === 'tool/result').map(event => event.data.message.content[0]);
      assert.deepEqual(results.map(result => result.toolCallId), calls.map(call => call.data.callId), JSON.stringify(events.at(-1)));
      for (const [index, result] of results.entries()) {
        const nextMessages = adapter.requests[index + 1].messages;
        const visible = nextMessages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === result.toolCallId);
        assert.deepEqual(visible, result, 'The next model step must receive each recorded tool result');
      }
      return { events, calls, results };
    } finally { await reader.close(); }
  };
  return { root, store, run, adapter, ctx };
}

test('Windows tree deletion is denied before execution and its model-visible result survives JSONL replay', { timeout: 30000 }, async t => {
  const f = await fixture(t, [
    toolCallResponse('windows-delete', 'bash', { command: 'rm -rf .', workdir: 'C:\\work\\project' }),
    textResponse('The protected Windows tree was not deleted.'),
  ]);
  let executions = 0;
  await f.ctx.plugin({ name: 'synthetic-shell', inject: ['tools'], apply(ctx) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'bash', description: 'Synthetic shell with no filesystem effects.',
      parameters: { command: { type: 'string', required: true }, workdir: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: text => [{ type: 'text', text }] },
      async execute() { executions++; return 'must not execute'; },
    })));
  } }).await();
  await f.ctx.plugin(Guard, { resultReview: 'off', planReview: 'off' }).await();
  const { results } = await f.run();
  assert.equal(executions, 0);
  assert.equal(results[0].isError, true);
  assert.match(results[0].content[0].text, /ClawMaster Guard delete\.broad \(critical\)/);
  assert.match(results[0].content[0].text, /C:\/work\/project/);
});

test('live runtime observations reach the model and survive exact Session storage replay', { timeout: 30000 }, async t => {
  const f = await fixture(t, [toolCallResponse('status', 'runtime_status', {}), textResponse('Runtime checked.')], true);
  const { results } = await f.run();
  assert.equal(results[0].isError, false);
  const observation = JSON.parse(results[0].content[0].text);
  assert.equal(observation.available, true);
  const firstRequest = JSON.stringify(f.adapter.requests[0].messages);
  assert.ok(firstRequest.includes('Current ClawMaster runtime observation:'));
  assert.ok(firstRequest.includes('Treat remembered values as dated history.'));
  assert.deepEqual({
    available: observation.available,
    harnessVersion: observation.identity.harnessVersion,
    contentSha256: observation.identity.contentSha256,
    source: observation.identity.source,
  }, JSON.parse(await readFile(new URL('expected/runtime-status.json', import.meta.url), 'utf8')));
});

test('CSV processing and CRM maintenance record model-visible tool results and replay them from JSONL', { timeout: 30000 }, async t => {
  const f = await fixture(t, [
    toolCallResponse('csv', 'csv_process', { input_path: 'leads.csv', trim: true, deduplicate: true }),
    toolCallResponse('empty-crm', 'enterprise_query', { collection: 'contacts', offset: 0, limit: 10 }),
    toolCallResponse('save-contact', 'enterprise_command', { request: { generation: 0, revision: 0, commandId: 'save-synthetic-lead', command: { type: 'contact.upsert', contact } } }),
    toolCallResponse('saved-crm', 'enterprise_query', { collection: 'contacts', id: contact.id, offset: 0, limit: 10 }),
    textResponse('Synthetic CSV and CRM records checked.'),
  ]);
  f.ctx.on('approval/request', async event => {
    assert.equal(event.callId, 'save-contact');
    assert.equal(event.toolName, 'enterprise_command');
    assert.match(event.reason, /contact.upsert/);
    return 'allowed-once';
  });
  await writeFile(join(f.root, 'leads.csv'), 'name,company\n Synthetic Customer ,Fixture Company\n Synthetic Customer ,Fixture Company\n');
  const { events, calls, results } = await f.run();
  assert.equal(results.length, 4);
  for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
  const values = results.map(result => JSON.parse(result.content[0].text));
  const recorded = {
    tools: calls.map(call => call.data.name),
    approval: events.filter(event => event.type === 'approval/decided').map(event => ({ outcome: event.data.outcome })),
    csv: { rows: values[0].preview.rows, duplicatesRemoved: values[0].duplicatesRemoved },
    initialContacts: values[1].records,
    receipt: { generation: values[2].generation, revision: values[2].revision, commandId: values[2].commandId, type: values[2].type, entityId: values[2].entityId },
    contacts: values[3].records.map(({ updatedAt, ...row }) => row),
  };
  assert.deepEqual(recorded, JSON.parse(await readFile(new URL('expected/business-tool-flow.json', import.meta.url), 'utf8')));
  assert.equal(f.store.snapshot().revision, 1);
  assert.equal(f.store.snapshot().contacts[0].id, contact.id);
});

test('an ERP submission from the model records a real unavailable approval and leaves stock unchanged', { timeout: 30000 }, async t => {
  const f = await fixture(t, [
    toolCallResponse('submit-order', 'enterprise_command', { request: { generation: 0, revision: 2, commandId: 'submit-fixture-order', command: { type: 'order.submit', id: 'fixture-order' } } }),
    textResponse('The order was not submitted because approval is unavailable.'),
  ]);
  const item = { id: 'fixture-item', sku: 'FIXTURE', name: 'Synthetic inventory', stock: 5, reorderAt: 1, supplier: 'Fixture supplier' };
  f.store.execute({ revision: 0, commandId: 'seed-item', command: { type: 'item.upsert', item } });
  f.store.execute({ revision: 1, commandId: 'seed-order', command: { type: 'order.save', order: {
    id: 'fixture-order', kind: 'sale', counterparty: 'Fixture Company', orderDate: '2026-09-12', currency: 'CNY', note: '',
    lines: [{ itemId: item.id, quantity: 2, unitPriceMinorUnits: 100 }],
  } } });
  const before = f.store.snapshot();
  const { events, results } = await f.run();
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.match(results[0].content[0].text, /approval_unavailable/);
  const asked = events.find(event => event.type === 'approval/asked');
  const decided = events.find(event => event.type === 'approval/decided');
  assert.equal(asked.data.callId, 'submit-order');
  assert.equal(decided.data.id, asked.data.id);
  assert.equal(decided.data.outcome, 'unavailable');
  assert.deepEqual(f.store.snapshot(), before);
});

test('task byte rejection and history continuation reach the model and survive exact JSONL replay', { timeout: 30000 }, async t => {
  const task = { goal: 'Inspect fixture evidence', scope: 'Synthetic task', owner: { kind: 'local', label: 'Fixture operator' },
    dueAt: null, timezone: 'UTC', risk: 'low', checklist: [{ id: 'done', description: 'Verify fixture evidence' }] };
  const f = await fixture(t, [
    toolCallResponse('create-task', 'watchdog_task_command', { id: 'budget-task', revision: 0, commandId: 'create-task', command: { type: 'create', task } }),
    toolCallResponse('queue-task', 'watchdog_task_command', { id: 'budget-task', revision: 1, commandId: 'queue-task', command: { type: 'queue' } }),
    toolCallResponse('history-first', 'watchdog_task_query', { id: 'budget-task', history: true, limit: 1 }),
    toolCallResponse('history-next', 'watchdog_task_query', { id: 'budget-task', history: true, after: 1, limit: 1 }),
    toolCallResponse('oversized-task', 'watchdog_task_command', { id: 'budget-task', revision: 2, commandId: 'oversized-task',
      command: { type: 'revise', task: { ...task, checklist: Array.from({ length: 100 }, (_, i) => ({ id: `criterion-${i}`, description: 'x'.repeat(4000) })) } } }),
    toolCallResponse('unchanged-task', 'watchdog_task_query', { id: 'budget-task' }),
    textResponse('The task remains ready at revision two; the oversized revision did not commit.'),
  ], false, true);
  f.ctx.on('approval/request', async () => 'allowed-once');
  const { results } = await f.run();
  const first = JSON.parse(results[2].content[0].text);
  const next = JSON.parse(results[3].content[0].text);
  const current = JSON.parse(results[5].content[0].text);
  for (const result of results) assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  const recorded = {
    first: { revisions: first.tasks.map(task => task.revision), nextAfter: first.nextAfter },
    next: { revisions: next.tasks.map(task => task.revision), nextAfter: next.nextAfter },
    rejected: { isError: results[4].isError, content: results[4].content },
    retained: { id: current.id, revision: current.revision, status: current.status, checklist: current.checklist },
  };
  assert.deepEqual(recorded, JSON.parse(await readFile(new URL('expected/watchdog-task-budget.json', import.meta.url), 'utf8')));
  assert.equal(f.store.tasks.history(LOCAL_HTTP_IDENTITY, 'budget-task').tasks.length, 2);
});
