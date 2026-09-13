/** Vault watcher: fingerprinting, external-edit detection and clean disposal. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultWatcher, fingerprint, isIgnoredPath } from '../src/watcher.ts';

const temporary = () => mkdtemp(join(tmpdir(), 'clawmaster-watcher-'));

/** Wait until `check` passes or the deadline expires. */
async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

describe('ignored paths', () => {
  it('skips hidden entries at any depth but keeps real notes', () => {
    assert.equal(isIgnoredPath('.obsidian/workspace.json'), true);
    assert.equal(isIgnoredPath('目录/.hidden.md'), true);
    assert.equal(isIgnoredPath('目录/笔记.md'), false);
    assert.equal(isIgnoredPath('笔记.md'), false);
  });
});

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

describe('watcher', () => {
  it('reports a new version after an external write', async () => {
    const root = await temporary();
    const watcher = await VaultWatcher.open(root);
    try {
      // Fail with the real reason instead of a bare timeout when the OS refuses a watch.
      assert.equal(watcher.active, true, `filesystem watch unavailable: ${watcher.unavailableReason ?? 'unknown'}`);
      const before = watcher.current();
      await writeFile(join(root, '外部.md'), '# 外部写入\n');
      // Generous budget: the event path is an accelerator, and a loaded machine can delay it.
      const moved = await until(async () => watcher.current() !== before, 10000);
      assert.equal(moved, true, 'the watcher never observed the external write');
      assert.notEqual(watcher.current(), before);
    } finally { watcher.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('recomputes on demand for a caller that does not wait for an event', async () => {
    const root = await temporary();
    const watcher = await VaultWatcher.open(root);
    try {
      const before = watcher.current();
      await writeFile(join(root, 'a.md'), 'one');
      assert.equal(await watcher.recompute(), await fingerprint(root));
      assert.notEqual(watcher.current(), before);
    } finally { watcher.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('stops reporting after close and tolerates a double close', async () => {
    const root = await temporary();
    const watcher = await VaultWatcher.open(root);
    watcher.close();
    watcher.close();
    const settled = watcher.current();
    await writeFile(join(root, 'a.md'), 'after close');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(watcher.current(), settled);
    await rm(root, { recursive: true, force: true });
  });
});
