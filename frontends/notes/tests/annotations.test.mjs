/** Annotations: the sidecar marks a person or an agent leaves on a note. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANNOTATION_DIRECTORY, AnnotationStore } from '../src/annotations.ts';
import { Vault, VaultError } from '../src/vault.ts';
import { fingerprint } from '../src/watcher.ts';

const temporary = () => mkdtemp(join(tmpdir(), 'clawmaster-annotations-'));
const clock = new Date('2026-09-14T06:30:00.000Z');
const QUERY_LIMITS = { maxReadBytes: 262144, maxTreeEntries: 5000 };

/** Open a vault with one note and an annotation store over it. */
async function fixture(run) {
  const root = await temporary();
  try {
    const vault = await Vault.open(root);
    await vault.create('设计/面板.md', '# 面板\n\n第一行\n第二行\n');
    await vault.create('另一篇.md', '# 另一篇\n');
    return await run({ vault, store: new AnnotationStore(vault), root });
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('annotation store', () => {
  it('stores a mark with its anchor, source and time', async () => fixture(async ({ store, root }) => {
    const annotation = await store.add({
      id: '设计/面板.md', body: '这一行给出的是实测值，保留。', kind: 'highlight', source: 'human', author: 'king', line: 3, quote: '第一行',
    }, clock);
    assert.match(annotation.annotationId, /^[0-9a-f-]{36}$/);
    assert.deepEqual({ ...annotation, annotationId: '<id>' }, {
      annotationId: '<id>',
      id: '设计/面板.md',
      line: 3,
      quote: '第一行',
      kind: 'highlight',
      source: 'human',
      author: 'king',
      body: '这一行给出的是实测值，保留。',
      createdAt: clock.toISOString(),
    });
    const files = await readdir(join(root, ANNOTATION_DIRECTORY));
    assert.deepEqual(files, [`${annotation.annotationId}.json`]);
  }));

  it('defaults an agent mark to the ai source and allows a note-level remark', async () => fixture(async ({ store }) => {
    const annotation = await store.add({ id: '另一篇.md', body: '整篇都还没验证。', kind: 'risk' }, clock);
    assert.equal(annotation.source, 'ai');
    assert.equal(annotation.line, null);
    assert.equal(annotation.quote, null);
    assert.equal(annotation.author, null);
  }));

  it('refuses a draft that is not a usable annotation', async () => fixture(async ({ store }) => {
    await assert.rejects(store.add({ id: '另一篇.md', body: '', kind: 'comment' }), VaultError);
    await assert.rejects(store.add({ id: '另一篇.md', body: 'x', kind: 'nonsense' }), VaultError);
    await assert.rejects(store.add({ id: '', body: 'x', kind: 'comment' }), VaultError);
    await assert.rejects(store.add({ id: '../escape.md', body: 'x', kind: 'comment' }), VaultError);
    await assert.rejects(store.add({ id: '另一篇.md', body: 'x', kind: 'comment', line: 0 }), VaultError);
  }));

  it('keeps every mark when several are added', async () => fixture(async ({ store }) => {
    await store.add({ id: '设计/面板.md', body: '第一条', kind: 'comment', line: 1 }, clock);
    await store.add({ id: '设计/面板.md', body: '第二条', kind: 'todo', line: 3 }, clock);
    await store.add({ id: '另一篇.md', body: '别的笔记', kind: 'comment', line: 1 }, clock);
    // Reading order is line first, then note id — both marks on line 1 come before the one on line 3.
    assert.deepEqual((await store.list()).map(annotation => annotation.body), ['别的笔记', '第一条', '第二条']);
    assert.deepEqual((await store.list('设计/面板.md')).map(annotation => annotation.body), ['第一条', '第二条']);
  }));

  it('reads a note-level remark after the positional ones', async () => fixture(async ({ store }) => {
    await store.add({ id: '设计/面板.md', body: '整篇', kind: 'comment' }, clock);
    await store.add({ id: '设计/面板.md', body: '第三行', kind: 'comment', line: 3 }, clock);
    assert.deepEqual((await store.list('设计/面板.md')).map(annotation => annotation.body), ['第三行', '整篇']);
  }));

  it('does not let one unreadable file hide the readable marks', async () => fixture(async ({ store, root }) => {
    await store.add({ id: '另一篇.md', body: '可读的一条', kind: 'comment' }, clock);
    await writeFile(join(root, ANNOTATION_DIRECTORY, 'broken.json'), '{ not json', 'utf8');
    assert.deepEqual((await store.list()).map(annotation => annotation.body), ['可读的一条']);
  }));

  it('removes a mark once and reports a miss afterwards', async () => fixture(async ({ store }) => {
    const annotation = await store.add({ id: '另一篇.md', body: '待删', kind: 'comment' }, clock);
    assert.equal(await store.remove(annotation.annotationId), true);
    assert.equal(await store.remove(annotation.annotationId), false);
    assert.deepEqual(await store.list(), []);
  }));

  it('stays out of the note list and out of the note revision', async () => fixture(async ({ store, vault, root }) => {
    const before = await fingerprint(root);
    await store.add({ id: '设计/面板.md', body: '不该改动笔记', kind: 'comment', line: 1 }, clock);
    assert.deepEqual((await vault.list(QUERY_LIMITS)).map(entry => entry.id).sort(), ['另一篇.md', '设计/面板.md']);
    assert.equal(await fingerprint(root), before, 'an annotation must not move the vault fingerprint');
  }));
});
