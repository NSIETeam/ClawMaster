import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphMemoryEngine, panelProjection } from '../src/engine.ts';
import { GraphStore } from '../src/store.ts';

function memoryStorage() {
  let global = null;
  let open = false;
  let closed = false;
  const unit = {
    async loadAll() { if (closed) throw new Error('closed'); return { tables: {}, global }; },
    async setGlobal(value) { if (closed) throw new Error('closed'); global = structuredClone(value); },
    async putRecord() {}, async deleteRecord() {}, async close() { closed = true; open = false; },
  };
  const backend = { kv: { async open(descriptor) { assert.equal(open, false); open = true; assert.equal(descriptor.name, 'clawmaster_graph_memory'); return unit; } }, async close() {} };
  return { storage: { backend: { get(name) { assert.equal(name, 'sqlite'); return backend; } } }, state: () => global };
}

const snapshot = {
  schemaVersion: 1,
  generatedAt: '2026-09-14T10:00:00.000Z',
  sources: [
    { id: 'notes', kind: 'notes', label: '笔记库', location: '/vault', documents: 1 },
    { id: 'memory', kind: 'memory', label: '长期记忆', location: 'viking-memory', documents: 1 },
  ],
  nodes: [
    { id: 'note:a', kind: 'note', path: '评估/并发.md', title: '并发评估', fileType: 'md', hash: 'a', mtimeMs: 1, size: 10, meta: { tokenCounts: { 并发: 2 } } },
    { id: 'memory:b', kind: 'memory', path: 'memories/审批.md', title: '审批偏好', fileType: 'md', hash: 'b', mtimeMs: 1, size: 10, meta: { tokenCounts: { 审批: 2 } } },
    { id: 'cluster:c', kind: 'cluster', path: null, title: '审批', fileType: null, hash: 'c', mtimeMs: 0, size: 2, meta: {} },
  ],
  edges: [
    { src: 'note:a', dst: 'memory:b', kind: 'similar_to', weight: 0.8, evidence: '共同高权重词：审批' },
    { src: 'note:a', dst: 'cluster:c', kind: 'in_cluster', weight: 1, evidence: '共享主题' },
  ],
  unresolved: [], errors: [],
};

test('graph snapshot is persisted through ctx.storage as one validated replacement', async () => {
  const fixture = memoryStorage();
  const store = await GraphStore.open(fixture.storage);
  assert.equal((await store.read()).generatedAt, '');
  await store.replace(snapshot);
  assert.deepEqual(fixture.state(), snapshot);
  assert.deepEqual(await store.read(), snapshot);
  await store.close();
});

test('query returns a direct hit and edge-backed related memory with evidence', async () => {
  const fixture = memoryStorage();
  const store = await GraphStore.open(fixture.storage);
  await store.replace(snapshot);
  const engine = new GraphMemoryEngine(store);
  const result = await engine.query({ query: '并发' });
  assert.deepEqual(result.hits.map(hit => hit.kind), ['note']);
  assert.deepEqual(result.related.map(hit => hit.kind), ['memory']);
  assert.match(result.related[0].why, /共同高权重词/);
  assert.match(result.related[0].via, /similar_to/);
  await engine.close();
});

test('panel projection exposes topic nodes and similarity in both directions', () => {
  const projected = panelProjection(snapshot);
  assert.deepEqual(projected.themes.map(node => node.title), ['审批']);
  assert.equal(projected.similar['note:a'][0].node.id, 'memory:b');
  assert.equal(projected.similar['memory:b'][0].node.id, 'note:a');
  assert.equal('tokenCounts' in projected.graph.nodes[0].meta, false);
});
