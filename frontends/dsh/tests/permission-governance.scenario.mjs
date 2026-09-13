/** Real DSH permission defaults, durable switches and one-shot file approvals. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Context } from '../../../vendor/cordis/src/index.ts';
import SessionStore, { Session, SessionId } from '../../../packages/core/session/src/index.ts';
import SessionProjections from '../../../packages/session/session-projection/src/index.ts';
import SystemPrompt from '../../../packages/core/system-prompt/src/index.ts';
import ToolRuntime from '../../../packages/core/tools/src/index.ts';
import ApprovalService from '../../../packages/interaction/user-approval/src/index.ts';
import PermissionPresets from '../../../packages/interaction/permission-presets/src/index.ts';
import Commands from '../../../packages/interaction/commands/src/index.ts';
import SandboxPolicy from '../../../packages/sandbox/sandbox-policy/src/index.ts';
import SandboxedFileSystem from '../../../packages/fs/fs-sandbox/src/index.ts';
import * as ObservationPolicy from '../../../packages/fs/fs-observation-policy/src/index.ts';
import { MemorySettings } from '../../../packages/settings/settings/tests/memory.ts';
import { applyDataTools } from '../src/data-tools.ts';
import { applyPermissionGovernance, constrainDelegatedPermissions } from '../src/permission-governance.ts';
import AgentLoop from '../../../packages/core/agent-loop/src/index.ts';
import { mountAgentLoopTestDependencies } from '../../../packages/test-support/agent-loop-testkit/src/index.ts';
import JsonlPersistence from '../../../packages/session/session-persistence-jsonl/src/index.ts';
import SubagentRuntime from '../../../packages/subagent/subagent/src/index.ts';
import * as SubagentSpawn from '../../../packages/subagent/subagent-spawn-in-process/src/index.ts';
import { TestSessionQuery } from '../../../packages/subagent/subagent/tests/test-session-query.ts';
import { loadStoredSession } from '../../../packages/subagent/subagent/tests/persistence-helpers.ts';
import { queueHostSubagentPrompt } from '../../../packages/subagent/subagent/src/internal.ts';
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts';
import * as ToolFs from '../../../packages/fs/tool-fs/src/index.ts';
import { setSandboxMode } from '../../../packages/sandbox/sandbox-policy/src/index.ts';

const rows = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
});
const configOf = id => rows.find(row => row.id === id)?.config;

async function fixture(t, storedDefault) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-permission-'));
  const ctx = new Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const mount = async (plugin, config) => { await ctx.plugin(plugin, config).await(); };
  await mount(SessionStore);
  await mount(SessionProjections);
  await mount(SystemPrompt);
  await mount(ToolRuntime);
  await mount(MemorySettings, storedDefault ? { doc: { permission: { defaultPreset: storedDefault } } } : {});
  await mount(SandboxPolicy, { ...configOf('sandbox-policy'), workspaceRoot: root });
  await mount(SandboxedFileSystem, { cwd: root });
  await mount(ObservationPolicy);
  await mount(ApprovalService, configOf('approval'));
  await mount(Commands);
  // This fixture executes filesystem tools; the preset service also requires a shell capability declaration.
  ctx.provide('shell', { sandboxMode: ctx.sandboxPolicy.defaultMode });
  await mount(PermissionPresets, configOf('permission'));
  await mount({ name: 'governance-csv-tools', inject: ['tools', 'fs', 'sandboxPolicy'], apply: context => applyDataTools(context) });
  const session = ctx.sessions.create(SessionId('permission-fixture'), { meta: { cwd: root } });
  const agent = { id: session.id, session, inject() {} };
  let sequence = 0;
  const call = args => ctx.tools.execute({
    name: 'csv_process', arguments: args, agent,
    signal: new AbortController().signal, callId: `governance-${++sequence}`,
  });
  return { ctx, root, session, agent, call };
}

test('ClawMaster pins new Sessions to read-only and ask while explicit user choices remain selectable', async t => {
  const f = await fixture(t);
  assert.equal(f.ctx.permissionPresets.defaultPreset, 'read-only');
  assert.equal(f.ctx.permissionPresets.current(f.session), 'read-only');
  assert.deepEqual(f.ctx.permissionPresets.names, ['read-only', 'workspace-write', 'danger-full-access']);
  assert.deepEqual(f.session.snapshotEvents().map(event => [event.type, event.data]), [
    ['permission/preset', { preset: 'read-only' }],
    ['sandbox/mode', { mode: 'read-only' }],
    ['approval/policy', { policy: 'ask' }],
  ]);
});

test('the ClawMaster Agent Teams layer preserves its storage/provider while limiting members and depth', () => {
  assert.deepEqual(configOf('agent-teams'), { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 1, maxMembers: 3 });
});

test('Settings and the permission command restore a stored full-access Session without sending a model request', async t => {
  const f = await fixture(t, 'danger-full-access');
  assert.equal(f.ctx.permissionPresets.current(f.session), 'danger-full-access');
  await f.ctx.settings.update('permission', { defaultPreset: 'read-only' });
  assert.equal(f.ctx.permissionPresets.current(f.session), 'danger-full-access');
  assert.equal(f.ctx.permissionPresets.current(f.ctx.sessions.create(SessionId('fresh-safe'))), 'read-only');
  const execution = await f.ctx.commands.execute(f.agent, '/permission read-only', [], new AbortController().signal);
  assert.equal(execution.result.kind, 'success');
  assert.equal(f.ctx.permissionPresets.current(f.session), 'read-only');
  assert.equal(f.session.snapshotEvents().findLast(event => event.type === 'approval/policy').data.policy, 'ask');
  const replay = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header);
  assert.equal(f.ctx.permissionPresets.current(replay), 'read-only');
  assert.equal(f.session.snapshotEvents().some(event => event.type === 'request/header'), false);
});

test('reads need no approval and a write waits for a one-shot decision, with rejection preserving files', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'input.csv'), 'name\nSynthetic fixture\n');
  f.session.append('turn/start', { turn: 1 });
  let asked;
  let answer;
  const pending = new Promise(resolve => { asked = resolve; });
  const decision = new Promise(resolve => { answer = resolve; });
  let questions = 0;
  f.ctx.on('approval/request', async request => { questions++; asked(request); return decision; });
  assert.equal((await f.call({ input_path: 'input.csv' })).isError, false);
  assert.equal(questions, 0);
  const denied = await f.call({ input_path: 'input.csv', output_path: 'unapproved.csv' });
  assert.equal(denied.error.info.code, 'FS_SANDBOX_DENIED');
  assert.deepEqual(await readdir(f.root), ['input.csv']);
  let settled = false;
  const write = f.call({ input_path: 'input.csv', output_path: 'reviewed.csv', sandbox_permissions: 'workspace-write', justification: 'Save only this synthetic CSV result.' });
  write.then(() => { settled = true; });
  const request = await pending;
  assert.equal(request.toolName, 'csv_process');
  assert.equal(settled, false);
  assert.equal(questions, 1);
  assert.deepEqual(await readdir(f.root), ['input.csv']);
  answer('rejected');
  assert.equal((await write).isError, true);
  assert.deepEqual(await readdir(f.root), ['input.csv']);
  const events = f.session.snapshotEvents().filter(event => event.type.startsWith('approval/'));
  assert.equal(events.find(event => event.type === 'approval/decided').data.outcome, 'rejected');
  assert.equal(f.ctx.sandboxPolicy.resolve({ session: f.session }).mode, 'read-only');
});

test('missing or cyclic parent authority reduces a delegated Session to read-only and never', async t => {
  const f = await fixture(t);
  f.ctx.provide('agents', { get: () => undefined });
  const child = Session.create(SessionId('unowned-child'), undefined, { ...f.session.header, id: SessionId('unowned-child'), origin: 'subagent', parentSession: SessionId('missing-parent') });
  const agent = { id: child.id, session: child };
  setSandboxMode(child, 'danger-full-access');
  constrainDelegatedPermissions(f.ctx, agent);
  assert.equal(f.ctx.sandboxPolicy.resolve({ session: child }).mode, 'read-only');
  assert.equal(f.ctx.approval.overrideOf(child), 'never');
  const unchanged = child.snapshotEvents().length;
  constrainDelegatedPermissions(f.ctx, agent);
  assert.equal(child.snapshotEvents().length, unchanged);
  const circular = Session.create(SessionId('circular-child'), undefined, { ...child.header, id: SessionId('circular-child'), parentSession: SessionId('circular-child') });
  const circularAgent = { id: circular.id, session: circular };
  f.ctx.agents.get = () => circularAgent;
  setSandboxMode(circular, 'danger-full-access');
  constrainDelegatedPermissions(f.ctx, circularAgent);
  assert.equal(f.ctx.sandboxPolicy.resolve({ session: circular }).mode, 'read-only');
});

test('a persisted continuable child loses former write access on cold resume after its parent is restricted', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-child-policy-'));
  const ctx = new Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') }).await();
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root }).await();
  await ctx.plugin(SandboxedFileSystem, { cwd: root }).await();
  await ctx.plugin(ToolFs).await();
  await ctx.plugin(ApprovalService).await();
  await ctx.plugin(AgentLoop, { agents: [] }).await();
  await ctx.plugin(TestSessionQuery).await();
  await ctx.plugin(SubagentRuntime).await();
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }).await();
  const blocked = join(root, 'unapproved.txt');
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    textResponse('Initial synthetic turn completed.'),
    toolCallResponse('forbidden-write', 'write', { file_path: blocked, content: 'must not be written' }),
    textResponse('The restricted write did not execute.'),
    textResponse('A new child also starts restricted.'),
  ]));
  ctx.llm.registerAdapter(['captain'], new MockAdapter(Array.from({ length: 6 }, () => textResponse('Synthetic child report received.'))));
  const parent = await ctx.agentLoop.create(SessionId('governance-parent'), { provider: 'captain', model: 'mock' }, { cwd: root });
  setSandboxMode(parent.session, 'workspace-write');
  const start = () => ctx.subagents.startContinuable({ provider: 'spawn', label: 'synthetic policy check', request: { prompt: [{ type: 'text', text: 'Use only synthetic fixture data.' }], parent, agentOptions: { provider: 'mock', model: 'mock' } }, signal: new AbortController().signal });
  const waitReleased = async id => {
    const expires = Date.now() + 10000;
    while (ctx.agents.get(id) !== undefined) {
      assert.ok(Date.now() < expires, 'the owned child must release its live activation');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const first = await start();
  await waitReleased(first.childId);
  const initial = await loadStoredSession(ctx.sessionPersistence, first.childId);
  assert.equal(initial.events.findLast(event => event.type === 'sandbox/mode').data.mode, 'workspace-write');
  setSandboxMode(parent.session, 'read-only');
  await ctx.plugin({ name: 'clawmaster-permission-governance', inject: ['agents', 'sandboxPolicy', 'approval'], apply: applyPermissionGovernance }).await();
  await queueHostSubagentPrompt(ctx.subagents, parent, first.childId, [{ type: 'text', text: 'Continue the synthetic fixture.' }], { kind: 'user' }, new AbortController().signal);
  await waitReleased(first.childId);
  const resumed = await loadStoredSession(ctx.sessionPersistence, first.childId);
  assert.deepEqual(resumed.events.filter(event => event.type === 'sandbox/mode').map(event => event.data), [
    { mode: 'workspace-write', source: 'delegation' }, { mode: 'read-only' },
  ]);
  assert.equal(resumed.events.findLast(event => event.type === 'approval/policy').data.policy, 'never');
  await assert.rejects(readFile(blocked), { code: 'ENOENT' });
  const tool = resumed.events.find(event => event.type === 'tool/result');
  assert.match(JSON.stringify(tool.data), /read-only/);
  const second = await start();
  await waitReleased(second.childId);
  const fresh = await loadStoredSession(ctx.sessionPersistence, second.childId);
  assert.equal(fresh.events.findLast(event => event.type === 'sandbox/mode').data.mode, 'read-only');
  assert.equal(fresh.events.findLast(event => event.type === 'approval/policy').data.policy, 'never');
});
