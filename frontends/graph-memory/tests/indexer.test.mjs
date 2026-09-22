import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { contentHash } from '../src/algorithms.ts';
import { indexSources, indexSourcesIncremental } from '../src/indexer.ts';

const config = {
  memory: 'off', includePeerMemory: false, maxMemoryEntries: 1,
  similarityThreshold: 0.18, similarPerDocument: 3, fileSources: [],
};

test('incremental refresh reads only notes whose metadata changed', async () => {
  const entries = [
    { id: 'alpha.md', title: 'Alpha', size: 7, mtimeMs: 1 },
    { id: 'beta.md', title: 'Beta', size: 6, mtimeMs: 1 },
  ];
  const bodies = new Map([['alpha.md', '# Alpha'], ['beta.md', '# Beta']]);
  const reads = [];
  const notes = {
    root: '/vault', async list() { return entries.map(entry => ({ ...entry })); },
    async read(id) { reads.push(id); const text = bodies.get(id); return { id, title: id.replace('.md', ''), text, revision: `sha256-${contentHash(text)}`, links: [], tags: [] }; },
  };
  const first = await indexSourcesIncremental(notes, config, []);
  assert.deepEqual(reads, ['alpha.md', 'beta.md']);
  const second = await indexSourcesIncremental(notes, config, first.documents);
  assert.deepEqual(reads, ['alpha.md', 'beta.md']);
  entries[1].mtimeMs = 2;
  entries[1].size = 14;
  bodies.set('beta.md', '# Beta changed');
  const third = await indexSourcesIncremental(notes, config, second.documents);
  assert.deepEqual(reads, ['alpha.md', 'beta.md', 'beta.md']);
  assert.equal(third.documents.find(document => document.path === 'beta.md').text, '# Beta changed');
});

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
