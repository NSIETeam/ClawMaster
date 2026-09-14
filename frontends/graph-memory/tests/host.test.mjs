import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import { apply, GRAPH_MEMORY_ACCESS_KEY } from '../src/host.ts';
import { GRAPH_MEMORY_GRAPH_PATH, GRAPH_MEMORY_QUERY_PATH, GRAPH_MEMORY_REFRESH_PATH } from '../src/protocol.ts';

function harness({ listError } = {}) {
  const routes = new Map();
  const tools = new Map();
  const provided = new Map();
  const listeners = new Map();
  let install;
  let global = null;
  const unit = {
    async loadAll() { return { tables: {}, global }; },
    async setGlobal(value) { global = structuredClone(value); },
    async putRecord() {}, async deleteRecord() {}, async close() {},
  };
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path); } } },
    tools: { register(tool) { assertSupportedJsonSchema(tool.output.schema); tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    storage: { backend: { get() { return { kv: { async open() { return unit; } }, async close() {} }; } } },
    provide(key, value) { provided.set(key, value); },
    get(key) {
      if (key !== 'clawmasterNotes') return undefined;
      return {
        root: '/vault',
        async list() { if (listError) throw new Error(listError); return [{ id: 'Alpha.md', title: 'Alpha', size: 36, mtimeMs: 1 }]; },
        async read() { return { id: 'Alpha.md', title: 'Alpha', text: '# Alpha\n\nGraph memory unifies notes.', revision: `sha256-${'a'.repeat(64)}`, links: [], tags: ['memory'] }; },
      };
    },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event); },
    effect(operation) { install = operation(); },
  };
  return { ctx, routes, tools, provided, listeners, async dispose() { const remove = await install; await remove(); } };
}

test('host registers authenticated routes, zod-derived tools and shared access', async () => {
  const h = harness();
  await apply(h.ctx, { memory: 'off' });
  assert.deepEqual([...h.routes.keys()].sort(), [GRAPH_MEMORY_GRAPH_PATH, GRAPH_MEMORY_QUERY_PATH, GRAPH_MEMORY_REFRESH_PATH].sort());
  assert.deepEqual([...h.tools.keys()].sort(), ['graph_memory_plan_writeback', 'graph_memory_query', 'graph_memory_refresh']);
  assert.equal(typeof h.provided.get(GRAPH_MEMORY_ACCESS_KEY).query, 'function');
  const query = h.tools.get('graph_memory_query');
  assert.equal(query.parameters.type, 'object');
  assert.deepEqual(Object.keys(query.parameters.properties).sort(), ['file', 'hops', 'limit', 'query']);
  assert.equal(query.isConcurrencySafe({ query: 'x' }), true);
  assert.equal(query.isConcurrencySafe({ limit: 'wrong' }), false);
  const refresh = h.tools.get('graph_memory_refresh');
  assert.equal((await refresh.execute({}, { signal: new AbortController().signal })).documents, 1);
  const writeback = await h.tools.get('graph_memory_plan_writeback').execute({
    noteTitle: '决策', memoryTitle: '偏好',
    items: [{ kind: 'decision', text: '采用同一索引' }, { kind: 'preference', text: '偏好中文' }],
  }, { signal: new AbortController().signal });
  assert.deepEqual(writeback.map(item => [item.destination, item.reciprocalLink]), [['notes', '[[偏好]]'], ['memory', '[[决策]]']]);
  await h.dispose();
  assert.equal(h.routes.size, 0);
  assert.equal(h.tools.size, 0);
});

test('real ToolRuntime registers and validates every graph tool result', async t => {
  const ctx = new Context();
  const h = harness();
  t.after(async () => { await h.dispose(); await ctx.fiber.dispose(); });
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  h.ctx.tools = ctx.tools;
  await apply(h.ctx, { memory: 'off' });
  const run = async (name, args) => {
    const result = await ctx.tools.execute({ name, callId: name, arguments: args, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''));
  };
  const refreshed = await run('graph_memory_refresh', {});
  assert.equal(refreshed.documents, 1);
  assert.equal(typeof refreshed.nodes, 'number');
  const queried = await run('graph_memory_query', { query: 'Graph memory' });
  assert.equal(queried.hits[0].title, 'Alpha');
  const plan = await run('graph_memory_plan_writeback', {
    noteTitle: 'Decisions', memoryTitle: 'Preferences',
    items: [{ kind: 'decision', text: 'Shared index' }, { kind: 'preference', text: 'Chinese' }],
  });
  assert.deepEqual(plan.map(item => item.destination), ['notes', 'memory']);
});

test('routes build the graph and reject invalid query input', async () => {
  const h = harness();
  await apply(h.ctx, { memory: 'off' });
  const graph = await h.routes.get(GRAPH_MEMORY_GRAPH_PATH).fetch(new Request(`http://localhost${GRAPH_MEMORY_GRAPH_PATH}`));
  assert.equal(graph.status, 200);
  assert.equal((await graph.json()).graph.sources[0].documents, 1);
  const invalid = await h.routes.get(GRAPH_MEMORY_QUERY_PATH).fetch(new Request(`http://localhost${GRAPH_MEMORY_QUERY_PATH}`));
  assert.equal(invalid.status, 400);
  await h.dispose();
});

test('a vault listing failure logs and preserves the original step', async () => {
  const h = harness({ listError: 'vault unavailable' });
  const warnings = [];
  h.ctx.logger = { warn(message) { warnings.push(message); } };
  await apply(h.ctx, { memory: 'off' });
  const original = { kind: 'enter', messages: [{ content: 'find graph memory', source: { kind: 'user' } }] };
  const decision = await h.listeners.get('agent/pre-step')({ agent: {}, step: 1, messages: original.messages }, async () => original);
  assert.equal(decision, original);
  assert.match(warnings[0], /vault unavailable/);
  await h.dispose();
});

test('each opening turn receives a replacing snapshot with note body evidence', async () => {
  const h = harness();
  await apply(h.ctx, { memory: 'off' });
  const listener = h.listeners.get('agent/pre-step');
  const payload = { agent: {}, step: 1, messages: [{ content: 'How does graph memory unify notes?', source: { kind: 'user' } }] };
  const first = await listener(payload, async () => ({ kind: 'enter', messages: payload.messages }));
  const second = await listener(payload, async () => ({ kind: 'enter', messages: payload.messages }));
  for (const decision of [first, second]) {
    assert.equal(decision.messages.length, 2);
    assert.equal(decision.messages[1].source.form, 'snapshot');
    assert.equal(decision.messages[1].source.plugin, 'clawmaster-graph-memory');
    assert.match(decision.messages[1].content[0].text, /Graph memory unifies notes/);
  }
  await h.dispose();
});

test('host bundle contains no subprocess or direct sqlite bridge', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../dist/index.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /node:child_process|execFile|node:sqlite/);
});
