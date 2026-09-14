import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { indexSources } from '../src/indexer.ts';

test('binary files contribute metadata but never body bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-graph-memory-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'deck'));
  await writeFile(join(root, 'deck', 'Roadmap.pptx'), Buffer.from('PRIVATE_BINARY_BODY_TOKEN'));
  const notes = { root: '/vault', async list() { return []; }, async read() { throw new Error('unused'); } };
  const graph = await indexSources(notes, {
    memory: 'off', includePeerMemory: false, maxMemoryEntries: 1,
    similarityThreshold: 0.18, similarPerDocument: 3,
    fileSources: [{ label: 'deliverables', path: root }],
  });
  const binary = graph.nodes.find(node => node.path === 'deliverables/deck/Roadmap.pptx');
  assert.equal(binary.meta.indexed, 'metadata-only');
  assert.equal(Object.hasOwn(binary.meta.tokenCounts, 'private_binary_body_token'), false);
  assert.equal(JSON.stringify(graph).includes('PRIVATE_BINARY_BODY_TOKEN'), false);
});
