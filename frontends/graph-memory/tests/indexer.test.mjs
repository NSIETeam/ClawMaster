import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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

test('filesystem roots yield stable graph paths and basename titles without changing text', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-graph-memory-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '交付 # 1'));
  await writeFile(join(root, '交付 # 1', 'Roadmap.pptx'), 'PRIVATE_BINARY_BODY_TOKEN');
  const text = '# Review C:\\Work\\Docs\n\n[[Roadmap]]\n';
  await writeFile(join(root, '交付 # 1', 'Review.md'), text);
  const notes = { root: '/vault', async list() { return []; }, async read() { throw new Error('unused'); } };
  for (const path of [root, `${root}${sep}`, `${root}${sep}.${sep}`]) {
    const graph = await indexSources(notes, {
      memory: 'off', includePeerMemory: false, maxMemoryEntries: 1,
      similarityThreshold: 0.18, similarPerDocument: 3,
      fileSources: [{ label: 'deliverables', path }],
    });
    const binary = graph.nodes.find(node => node.id === 'file:deliverables:交付 # 1/Roadmap.pptx');
    assert.ok(binary, `Missing binary for source ${path}`);
    assert.equal(binary.path, 'deliverables/交付 # 1/Roadmap.pptx');
    assert.equal(binary.title, 'Roadmap.pptx');
    const markdown = graph.nodes.find(node => node.id === 'file:deliverables:交付 # 1/Review.md');
    assert.ok(markdown, `Missing text for source ${path}`);
    assert.equal(markdown.path, 'deliverables/交付 # 1/Review.md');
    assert.equal(markdown.title, 'Review C:\\Work\\Docs');
    assert.equal(markdown.hash, createHash('sha256').update(text).digest('hex'));
    assert.ok(graph.edges.some(edge => edge.kind === 'links_to' && edge.src === markdown.id && edge.dst === binary.id));
    assert.equal(graph.sources.find(source => source.kind === 'files').location, path);
    assert.equal(JSON.stringify(graph).includes('PRIVATE_BINARY_BODY_TOKEN'), false);
  }
});
