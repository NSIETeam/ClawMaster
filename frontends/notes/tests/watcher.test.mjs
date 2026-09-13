/** On-demand note revisions, scan failure recovery and quiescent disposal. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultWatcher, fingerprint } from '../src/watcher.ts';

const temporary = () => mkdtemp(join(tmpdir(), 'clawmaster-watcher-'));

describe('fingerprint', () => {
  it('changes when a note is added, edited or removed', async () => {
    const root = await temporary();
    try {
      const start = await fingerprint(root);
      await writeFile(join(root, 'a.md'), 'one');
      const added = await fingerprint(root);
      assert.notEqual(added, start);

      await writeFile(join(root, 'a.md'), 'two much longer');
      const edited = await fingerprint(root);
      assert.notEqual(edited, added);

      await rm(join(root, 'a.md'));
      assert.equal(await fingerprint(root), start);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('ignores hidden directories and non-note files', async () => {
    const root = await temporary();
    try {
      const start = await fingerprint(root);
      await mkdir(join(root, '.obsidian'), { recursive: true });
      await writeFile(join(root, '.obsidian', 'app.json'), '{}');
      await writeFile(join(root, 'notes.txt'), 'text');
      assert.equal(await fingerprint(root), start);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('revision scans', () => {
  it('observes external writes on the next request', async () => {
    const root = await temporary();
    const watcher = await VaultWatcher.open(root);
    try {
      const before = await watcher.recompute();
      await writeFile(join(root, '外部.md'), '# 外部写入\n');
      const after = await watcher.recompute();
      assert.equal(after, await fingerprint(root));
      assert.notEqual(after, before);
    } finally { await watcher.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('reports scan failures to the request and recovers on a later request', async t => {
    const root = await temporary();
    const watcher = await VaultWatcher.open(root);
    t.after(async () => { await watcher.close(); await rm(root, { recursive: true, force: true }); });
    try {
      t.mock.method(fsPromises, 'readdir', async () => { throw Object.assign(new Error('synthetic scan denied'), { code: 'EACCES' }); });
      syncBuiltinESMExports();
      await assert.rejects(watcher.recompute(), /synthetic scan denied/);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    await writeFile(join(root, 'a.md'), 'later request');
    assert.equal(await watcher.recompute(), await fingerprint(root));
  });

  it('shares concurrent scans and waits for their completion before closing', { timeout: 15000 }, async t => {
    const root = await temporary();
    const watcher = await VaultWatcher.open(root);
    const before = await watcher.recompute();
    const original = fsPromises.readdir;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let scan;
    let closing;
    try {
      await writeFile(join(root, 'pending.md'), 'pending change');
      t.mock.method(fsPromises, 'readdir', async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      });
      syncBuiltinESMExports();
      scan = watcher.recompute();
      await entered.promise;
      assert.equal(watcher.recompute(), scan);
      let closed = false;
      closing = watcher.close();
      void closing.then(() => { closed = true; });
      assert.equal(watcher.close(), closing);
      assert.equal(await watcher.recompute(), before);
      assert.equal(closed, false, 'close must await the blocked scan');
      release.resolve();
      await closing;
      assert.equal(await scan, before, 'a completed scan cannot publish after close');
      assert.equal(closed, true);
    } finally {
      release.resolve();
      await Promise.allSettled([scan, closing]);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await watcher.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
