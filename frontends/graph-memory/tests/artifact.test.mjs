import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

const shipped = await import('../dist/index.js');

test('shipped host artifact exposes the loader contract', () => {
  assert.equal(shipped.name, 'clawmaster-graph-memory');
  assert.deepEqual(shipped.inject, ['connection', 'tools', 'storage', 'storage.backend.sqlite', 'clawmasterNotes']);
  assert.equal(typeof shipped.apply, 'function');
});

test('bundle owns an external index path and declares only repository-available dependencies', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(patch, /\.clawmaster\/components\/graph-memory\/graph\.sqlite/);
  assert.doesNotMatch(patch, /ClawMaster 笔记|项目中枢/);
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-storage-sqlite'], 'file:../../packages/storage/storage-sqlite');
});
