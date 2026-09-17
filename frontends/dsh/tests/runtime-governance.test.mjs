/** Real tool dispatch proves resource denial and fresh identity reads without model calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { applyRuntimeGovernance, observeProcessTreeRss, observeRuntime, resolveRuntimeBudgets } from '../src/runtime-governance.ts';

test('runtime facts refuse stopped, malformed and different process records without a remembered fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-runtime-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'current.json');
  const observe = () => observeRuntime(path, process.pid, 'fixture-run');
  const state = { schemaVersion: 1, status: 'ready', runId: 'fixture-run', hostPid: process.pid, port: 17890,
    observedAtUnixMs: 1, desktopVersion: 'fixture', harnessVersion: 'fixture',
    contentSha256: 'a'.repeat(64), harnessRoot: root, disabledPlugins: [], buildProvenance: null };
  assert.equal(observe().available, false);
  await writeFile(path, JSON.stringify(state));
  assert.equal(observe().identity.contentSha256, 'a'.repeat(64));
  assert.equal(observe().identity.inventory, null, 'older build records without an inventory must not claim an empty inventory');
  assert.equal(JSON.stringify(observe()).includes(root), false, 'runtime identity must not disclose its installation path');
  await writeFile(path, JSON.stringify({ ...state, contentSha256: 'b'.repeat(64) }));
  assert.equal(observe().identity.contentSha256, 'b'.repeat(64));
  for (const invalid of [{ ...state, status: 'stopped' }, { ...state, hostPid: process.pid + 1 }, { ...state, runId: 'older-run' }, { ...state, port: '17890' }]) {
    await writeFile(path, JSON.stringify(invalid));
    assert.deepEqual(observe().identity, null);
  }
  await writeFile(path, '{');
  assert.equal(observe().available, false);
  assert.equal(observeRuntime(undefined).available, false);
});

test('runtime identity reports bounded component and patch digests without their paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-runtime-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'current.json');
  const fileIdentity = (filePath, sha256) => ({ path: filePath, bytes: 42, sha256 });
  const component = {
    name: '@clawmaster/dsh-notes', version: '0.1.0',
    manifest: fileIdentity('frontends/notes/package.json', 'b'.repeat(64)),
    artifacts: [
      fileIdentity('frontends/notes/dist/client.js', 'c'.repeat(64)),
      fileIdentity('frontends/notes/dist/index.js', 'd'.repeat(64)),
    ],
  };
  const state = {
    schemaVersion: 1, status: 'ready', runId: 'fixture-run', hostPid: process.pid, port: 17890,
    observedAtUnixMs: 1, desktopVersion: 'fixture', harnessVersion: 'fixture',
    contentSha256: 'a'.repeat(64), harnessRoot: root, disabledPlugins: [],
    buildProvenance: {
      mode: 'release', source: { gitCommit: 'e'.repeat(40), gitTree: 'f'.repeat(40), dirty: false, sourceSha256: '1'.repeat(64) },
      inventory: { components: [component], locks: [], patches: [fileIdentity('apps/desktop-tauri/patches/dsh-im@4.20.0.patch', '2'.repeat(64))] },
    },
  };
  await writeFile(path, JSON.stringify(state));
  const observation = observeRuntime(path, process.pid, 'fixture-run');
  assert.equal(observation.available, true);
  assert.ok(Number.isFinite(Date.parse(observation.observedAt)), 'the observation itself carries its as-of time');
  const expectedArtifactHash = createHash('sha256');
  for (const artifact of component.artifacts.slice().sort((left, right) => left.path.localeCompare(right.path))) {
    expectedArtifactHash.update(JSON.stringify([artifact.path, artifact.bytes, artifact.sha256]));
    expectedArtifactHash.update('\n');
  }
  assert.deepEqual(observation.identity.inventory.components, [{
    name: '@clawmaster/dsh-notes', version: '0.1.0', manifestSha256: 'b'.repeat(64), artifactCount: 2,
    artifactsSha256: expectedArtifactHash.digest('hex'),
  }]);
  assert.deepEqual(observation.identity.inventory.patches, [{ name: 'dsh-im@4.20.0.patch', sha256: '2'.repeat(64) }]);
  const rendered = JSON.stringify(observation);
  for (const secretPath of [root, 'frontends/notes', 'apps/desktop-tauri/patches']) assert.equal(rendered.includes(secretPath), false);
  assert.equal(rendered.includes('harnessRoot'), false);
  assert.equal(rendered.includes('credentials'), false);
  await writeFile(path, JSON.stringify({ ...state,
    buildProvenance: { ...state.buildProvenance, inventory: { components: Array.from({ length: 129 }, (_, index) => ({ ...component, name: `component-${index}` })), patches: [] } },
  }));
  assert.equal(observeRuntime(path, process.pid, 'fixture-run').available, false, 'oversized inventories are rejected instead of producing unbounded output');
});

async function fixture(t, budgets, body, readProcessTreeRss = () => null) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const governance = await ctx.plugin({ name: 'runtime-fixture', inject: ['tools', 'systemPrompt'],
    apply: context => applyRuntimeGovernance(context, budgets, readProcessTreeRss) });
  ctx.tools.register(defineTool({ name: 'heavy', description: 'Synthetic work', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true, execute: body }));
  let sequence = 0;
  return { ctx, governance, call: (name = 'heavy', signal = new AbortController().signal) => ctx.tools.execute({ name, arguments: {},
    callId: ToolCallId(`runtime-${++sequence}`), signal }) };
}

test('memory growth after preparation rejects queued dispatch before its body', async t => {
  let rss = 1024 * 1024;
  t.mock.method(process.memoryUsage, 'rss', () => rss);
  let executions = 0;
  const f = await fixture(t, { maxRssMiB: 4, heavyToolPatterns: ['^heavy$'] }, async () => { executions++; return 'done'; });
  const scheduler = f.ctx.tools[TOOL_RUNTIME_SCHEDULER];
  const prepared = await scheduler.prepare({ name: 'heavy', arguments: {}, callId: ToolCallId('queued'), signal: new AbortController().signal });
  assert.equal(prepared.kind, 'dispatch');
  rss = 5 * 1024 * 1024;
  const dispatched = await scheduler.dispatch(prepared.exec);
  const result = scheduler.finish(prepared.exec, dispatched.result);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /memory budget reached/);
  assert.equal(executions, 0);
});

test('cancellation retains its slot until the owned body has actually settled', { timeout: 10000 }, async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let release;
  const finish = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { maxRssMiB: 100000, heavyToolPatterns: ['^heavy$'] }, async () => {
    started(); await finish; return 'settled';
  });
  const controller = new AbortController();
  const pending = f.call('heavy', controller.signal);
  try {
    await began;
    controller.abort();
    assert.equal(JSON.parse((await f.call('runtime_status')).value).resources.activeHeavyTools, 1);
  } finally { release(); await pending; }
  assert.equal(JSON.parse((await f.call('runtime_status')).value).resources.activeHeavyTools, 0);
});

test('RSS admission refuses the body while read-only status remains available', async t => {
  let executions = 0;
  const f = await fixture(t, { maxRssMiB: 1, heavyToolPatterns: ['^heavy$'] }, async () => { executions++; return 'done'; });
  const denied = await f.call();
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /memory budget reached/);
  assert.equal(executions, 0);
  const status = await f.call('runtime_status');
  assert.equal(status.isError, false);
  assert.equal(JSON.parse(status.value).resources.maxRssMiB, 1);
  await f.governance.dispose();
  assert.equal((await f.call()).isError, false);
  assert.equal(executions, 1);
});

test('concurrent dispatch reserves slots before starting work and releases failed work', { timeout: 10000 }, async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let release;
  const finish = new Promise(resolve => { release = resolve; });
  let executions = 0;
  const f = await fixture(t, { maxRssMiB: 100000, maxConcurrentHeavyTools: 1, heavyToolPatterns: ['^heavy$'] }, async () => {
    executions++; started(); await finish; throw new Error('synthetic failure');
  });
  const first = f.call();
  try {
    await began;
    const second = await f.call();
    assert.equal(second.isError, true);
    assert.match(second.content[0].text, /concurrency budget reached/);
    assert.equal(executions, 1);
    assert.equal(JSON.parse((await f.call('runtime_status')).value).resources.activeHeavyTools, 1);
  } finally { release(); await first; }
  assert.equal(JSON.parse((await f.call('runtime_status')).value).resources.activeHeavyTools, 0);
  await f.call();
  assert.equal(executions, 2);
});

test('invalid resource budgets fail at load', () => {
  for (const config of [{ maxRssMiB: 0 }, { maxProcessTreeRssMiB: 0 }, { maxConcurrentHeavyTools: -1 }, { heavyToolPatterns: [] }, { heavyToolPatterns: ['['] }]) {
    assert.throws(() => resolveRuntimeBudgets(config));
  }
});

test('process-tree observer sums only the Host descendants and refuses malformed tables', () => {
  const table = '10 1 100\n11 10 200\n12 11 300\n13 999 900\n';
  assert.deepEqual(observeProcessTreeRss(10, 'darwin', () => table), { totalRssMiB: 1, descendantRssMiB: 1 });
  assert.equal(observeProcessTreeRss(9999, 'darwin', () => table), null);
  assert.equal(observeProcessTreeRss(10, 'darwin', () => 'bad'), null);
});

test('process-tree budget refuses a heavy operation while status stays readable', async t => {
  let executions = 0;
  const f = await fixture(t, { maxRssMiB: 100000, maxProcessTreeRssMiB: 10, heavyToolPatterns: ['^heavy$'] }, async () => { executions += 1; return 'done'; }, () => ({ totalRssMiB: 11, descendantRssMiB: 3 }));
  const denied = await f.call();
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /process-tree memory budget reached/);
  assert.equal(executions, 0);
  const status = await f.call('runtime_status');
  assert.equal(status.isError, false);
  assert.equal(JSON.parse(status.value).resources.processTreeRssMiB, 11);
});
