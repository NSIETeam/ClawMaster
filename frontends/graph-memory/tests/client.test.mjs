import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import { GraphMemoryContent } from '../src/panel.tsx';

test('panel renders topic pages and evidence-backed similar files', () => {
  const note = { id: 'note:a', kind: 'note', path: 'a.md', title: '架构决定', fileType: 'md', hash: 'a', mtimeMs: 1, size: 10, meta: {} };
  const memory = { id: 'memory:b', kind: 'memory', path: 'memories/b.md', title: '产品偏好', fileType: 'md', hash: 'b', mtimeMs: 0, size: 10, meta: {} };
  const topic = { id: 'cluster:c', kind: 'cluster', path: null, title: '统一检索', fileType: null, hash: 'c', mtimeMs: 0, size: 2, meta: {} };
  const edge = { src: note.id, dst: memory.id, kind: 'similar_to', weight: 0.8, evidence: '共同词：GraphRAG' };
  const graph = { schemaVersion: 1, generatedAt: '2026-09-14T00:00:00Z', sources: [], nodes: [note, memory, topic], edges: [edge], unresolved: [], errors: [] };
  const html = renderToStaticMarkup(createElement(GraphMemoryContent, {
    locale: 'zh-CN', data: { graph, themes: [topic], similar: { [note.id]: [{ edge, node: memory }], [memory.id]: [{ edge, node: note }] },
  } }));
  assert.match(html, /统一检索/);
  assert.match(html, /架构决定 ↔ 产品偏好/);
  assert.match(html, /共同词：GraphRAG/);
});
