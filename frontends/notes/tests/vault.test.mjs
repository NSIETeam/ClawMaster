/** Vault core: path policy, revisioned writes, frontmatter round trip and link facts. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  Vault, VaultError, WELCOME_NOTE, assertNoteId, assertWritableNoteId, extractLinks,
  noteTitle, openVault, parseFrontmatter, resolveVaultPath, revisionOf,
} from '../src/vault.ts';

const rejects = code => error => error instanceof VaultError && error.code === code;
const temporary = () => mkdtemp(join(tmpdir(), 'clawmaster-notes-'));
const QUERY_LIMITS = { maxReadBytes: 262144, maxTreeEntries: 5000 };

describe('note id policy', () => {
  it('accepts plain and nested relative note ids', () => {
    for (const id of ['a.md', '目录/笔记.md', '项目/ClawMaster.md', 'a.canvas']) {
      assert.equal(assertNoteId(id), id);
    }
  });

  it('refuses ids that are not plain relative note paths', () => {
    const refused = ['', '/etc/passwd.md', '../escape.md', 'a/../b.md', '.hidden.md', '.obsidian/x.md',
      'a\\b.md', 'C:/outside.md', 'a.md:stream.md', 'notes.txt', 'a//b.md', './a.md', ' padded.md', 'a\u0000.md'];
    for (const id of refused) {
      assert.throws(() => assertNoteId(id), rejects('invalid_path'), `expected refusal: ${JSON.stringify(id)}`);
    }
  });

  it('keeps canvases readable but not writable', () => {
    assert.equal(assertWritableNoteId('a.md'), 'a.md');
    assert.throws(() => assertWritableNoteId('board.canvas'), rejects('invalid_path'));
  });

  it('resolves inside the root and never outside it', () => {
    const root = join(tmpdir(), 'vault');
    assert.equal(resolveVaultPath(root, 'a/b.md'), join(root, 'a', 'b.md'));
    assert.throws(() => resolveVaultPath(root, '../b.md'), rejects('invalid_path'));
  });
});

describe('revision', () => {
  it('is the sidebar sha256 contract and is content addressed', () => {
    const first = revisionOf('hello');
    assert.match(first, /^sha256-[0-9a-f]{64}$/);
    assert.equal(first, revisionOf('hello'));
    assert.notEqual(first, revisionOf('hello!'));
    assert.equal(revisionOf(''), revisionOf(Buffer.from('')));
  });
});

describe('frontmatter', () => {
  it('reads flat scalars without rewriting the block', () => {
    const text = '---\ntitle: 我的笔记\ntags: [a, b]\ncreated: 2026-09-13\naliases: "x"\n---\n# 正文\n内容\n';
    const head = parseFrontmatter(text);
    assert.deepEqual(head.data, { title: '我的笔记', tags: ['a', 'b'], created: '2026-09-13', aliases: 'x' });
    assert.equal(head.body, '# 正文\n内容\n');
    assert.equal(head.raw + head.body, text);
  });

  it('preserves unknown and nested structures verbatim', () => {
    const text = '---\nnested:\n  - one\n  - two\n---\nbody\n';
    const head = parseFrontmatter(text);
    assert.equal(head.raw + head.body, text);
    assert.equal(head.body, 'body\n');
  });

  it('treats a note without a head as pure body', () => {
    const head = parseFrontmatter('just text');
    assert.equal(head.raw, undefined);
    assert.deepEqual(head.data, {});
    assert.equal(head.body, 'just text');
  });
});

describe('link extraction', () => {
  it('separates links from embeds and strips alias and heading', () => {
    const links = extractLinks('见 [[目标|别名]] 与 [[标题#小节]]，嵌 ![[图片.png]]');
    assert.deepEqual(links.links, ['标题', '目标']);
    assert.deepEqual(links.embeds, ['图片.png']);
  });

  it('collects body and frontmatter tags', () => {
    const links = extractLinks('---\ntags: [工作, 项目]\n---\n#标签 正文 #学习/算法\n');
    assert.deepEqual(links.tags, ['工作', '学习/算法', '标签', '项目'].sort());
  });

  it('ignores sample links and tags inside fenced code', () => {
    const links = extractLinks('```\n[[示例]] #示例\n```\n[[真实]] #真实\n');
    assert.deepEqual(links.links, ['真实']);
    assert.deepEqual(links.tags, ['真实']);
  });
});

describe('note title', () => {
  it('prefers the declared title, then the first heading, then the file name', () => {
    assert.equal(noteTitle('a.md', { title: '声明' }, '# 标题\n'), '声明');
    assert.equal(noteTitle('a.md', {}, '# 标题\n'), '标题');
    assert.equal(noteTitle('目录/我的笔记.md', {}, 'no heading'), '我的笔记');
  });
});

describe('vault io', () => {
  it('creates, reads and revision-guards writes', async () => {
    const root = await temporary();
    try {
      const vault = await Vault.open(root);
      const created = await vault.create('项目/ClawMaster.md', '# ClawMaster\n', QUERY_LIMITS.maxReadBytes);
      const read = await vault.read('项目/ClawMaster.md', QUERY_LIMITS.maxReadBytes);
      assert.equal(read.revision, created);
      assert.equal(read.title, 'ClawMaster');

      await assert.rejects(vault.save('项目/ClawMaster.md', '# 改写\n', revisionOf('stale'), QUERY_LIMITS.maxReadBytes), rejects('conflict'));
      const saved = await vault.save('项目/ClawMaster.md', '# 改写\n', read.revision, QUERY_LIMITS.maxReadBytes);
      assert.equal((await vault.read('项目/ClawMaster.md', QUERY_LIMITS.maxReadBytes)).text, '# 改写\n');
      assert.notEqual(saved, read.revision);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('never overwrites an existing note and reports the current revision', async () => {
    const root = await temporary();
    try {
      const vault = await Vault.open(root);
      const revision = await vault.create('a.md', 'one', QUERY_LIMITS.maxReadBytes);
      await assert.rejects(vault.create('a.md', 'two', QUERY_LIMITS.maxReadBytes), error =>
        rejects('conflict')(error) && error.currentRevision === revision);
      assert.equal((await vault.read('a.md', QUERY_LIMITS.maxReadBytes)).text, 'one');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports missing notes instead of creating them', async () => {
    const root = await temporary();
    try {
      const vault = await Vault.open(root);
      await assert.rejects(vault.read('missing.md', QUERY_LIMITS.maxReadBytes), rejects('not_found'));
      await assert.rejects(vault.save('missing.md', 'x', revisionOf('x'), QUERY_LIMITS.maxReadBytes), rejects('not_found'));
      await assert.rejects(vault.remove('missing.md'), rejects('not_found'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('renames and removes notes without clobbering', async () => {
    const root = await temporary();
    try {
      const vault = await Vault.open(root);
      await vault.create('a.md', 'a', QUERY_LIMITS.maxReadBytes);
      await vault.create('b.md', 'b', QUERY_LIMITS.maxReadBytes);
      await assert.rejects(vault.rename('a.md', 'b.md'), rejects('conflict'));
      await vault.rename('a.md', '目录/移动.md');
      assert.equal((await vault.list(QUERY_LIMITS)).map(entry => entry.id).join(','), 'b.md,目录/移动.md');
      await vault.remove('目录/移动.md');
      assert.deepEqual((await vault.list(QUERY_LIMITS)).map(entry => entry.id), ['b.md']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('lists notes only, skipping metadata, hidden and foreign files', async () => {
    const root = await temporary();
    try {
      const vault = await Vault.open(root);
      await vault.create('笔记.md', '# 笔记\n', QUERY_LIMITS.maxReadBytes);
      await mkdir(join(root, '.obsidian'), { recursive: true });
      await writeFile(join(root, '.obsidian', 'app.json'), '{}');
      await writeFile(join(root, 'readme.txt'), 'text');
      await writeFile(join(root, '.hidden.md'), 'hidden');
      await mkdir(join(root, '.clawmaster'), { recursive: true });
      await writeFile(join(root, '.clawmaster', 'index.db'), 'binary');
      assert.deepEqual((await vault.list(QUERY_LIMITS)).map(entry => entry.id), ['笔记.md']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('searches bodies and titles and reports backlinks', async () => {
    const root = await temporary();
    try {
      const vault = await Vault.open(root);
      await vault.create('源.md', '# 源\n\n第二行提到 关键词\n', QUERY_LIMITS.maxReadBytes);
      await vault.create('目标.md', '# 目标\n\n见 [[源]]\n', QUERY_LIMITS.maxReadBytes);
      const hits = await vault.search('关键词', 10, QUERY_LIMITS);
      assert.deepEqual(hits.map(hit => [hit.id, hit.lineNumber]), [['源.md', 3]]);
      assert.deepEqual((await vault.backlinks('源.md', QUERY_LIMITS)).map(entry => entry.id), ['目标.md']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('seeds the welcome note only while the vault is empty', async () => {
    const root = await temporary();
    try {
      const first = await openVault(root, QUERY_LIMITS.maxReadBytes);
      assert.deepEqual((await first.list(QUERY_LIMITS)).map(entry => entry.id), [WELCOME_NOTE]);
      const existing = await first.read(WELCOME_NOTE, QUERY_LIMITS.maxReadBytes);
      await first.save(WELCOME_NOTE, '# 我改过了\n', existing.revision, QUERY_LIMITS.maxReadBytes);
      const reopened = await openVault(root, QUERY_LIMITS.maxReadBytes);
      assert.equal((await reopened.read(WELCOME_NOTE, QUERY_LIMITS.maxReadBytes)).text, '# 我改过了\n');
      assert.equal((await reopened.list(QUERY_LIMITS)).length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a non-absolute vault root', async () => {
    await assert.rejects(Vault.open('relative/vault'), rejects('invalid_request'));
  });
});

async function isolatedVault(t) {
  const parent = await temporary();
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3 }));
  const vault = await Vault.open(join(parent, 'vault'));
  return { parent, root: vault.root, vault };
}

describe('canonical vault paths', () => {
  it('opens the native absolute path returned by the platform', async t => {
    const { root, vault } = await isolatedVault(t);
    assert.equal(vault.root, await realpath(root));
    await vault.create('本机.md', 'native path', QUERY_LIMITS.maxReadBytes);
    assert.equal((await vault.read('本机.md', 32)).text, 'native path');
  });

  it('refuses parent directory links for every read and mutation and leaves their targets untouched', async t => {
    const { parent, root, vault } = await isolatedVault(t);
    const outside = join(parent, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.md'), 'outside sentinel');
    await symlink(outside, join(root, 'linked'), 'junction');
    const revision = await vault.create('inside.md', 'inside sentinel', QUERY_LIMITS.maxReadBytes);
    for (const operation of [
      () => vault.read('linked/secret.md', 64),
      () => vault.save('linked/secret.md', 'changed', revisionOf('outside sentinel'), QUERY_LIMITS.maxReadBytes),
      () => vault.create('linked/nested/new.md', 'changed', QUERY_LIMITS.maxReadBytes),
      () => vault.append('linked/secret.md', 'changed', 64),
      () => vault.rename('inside.md', 'linked/moved.md'),
      () => vault.rename('linked/secret.md', 'moved.md'),
      () => vault.remove('linked/secret.md'),
    ]) await assert.rejects(operation, rejects('invalid_path'));
    assert.equal(await readFile(join(outside, 'secret.md'), 'utf8'), 'outside sentinel');
    assert.deepEqual(await readdir(outside), ['secret.md']);
    assert.equal((await vault.read('inside.md', 64)).revision, revision);
    assert.deepEqual((await vault.list(QUERY_LIMITS)).map(entry => entry.id), ['inside.md']);
  });

  it('refuses linked note files without reading or replacing the outside file', async t => {
    const { parent, root, vault } = await isolatedVault(t);
    const outside = join(parent, 'outside.md');
    await writeFile(outside, 'outside sentinel');
    try { await symlink(outside, join(root, 'linked.md'), 'file'); } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows account cannot create file symlinks; directory junction coverage still runs.'); return; }
      throw error;
    }
    await assert.rejects(vault.read('linked.md', 64), rejects('invalid_path'));
    await assert.rejects(vault.create('linked.md', 'changed', QUERY_LIMITS.maxReadBytes), rejects('invalid_path'));
    await assert.rejects(vault.save('linked.md', 'changed', revisionOf('outside sentinel'), QUERY_LIMITS.maxReadBytes), rejects('invalid_path'));
    await assert.rejects(vault.remove('linked.md'), rejects('invalid_path'));
    assert.equal(await readFile(outside, 'utf8'), 'outside sentinel');
    assert.deepEqual(await vault.list(QUERY_LIMITS), []);
  });
});

describe('cooperative writes', () => {
  it('publishes only one of two simultaneous creates from separate vault instances', async t => {
    const { root, vault } = await isolatedVault(t);
    const second = await Vault.open(root);
    let release;
    const start = new Promise(resolve => { release = resolve; });
    const operations = [vault, second].map(async (writer, index) => {
      await start;
      return writer.create('race.md', `writer ${index}`, QUERY_LIMITS.maxReadBytes);
    });
    release();
    const results = await Promise.allSettled(operations);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const loser = results.find(result => result.status === 'rejected');
    assert.equal(loser.reason.code, 'conflict');
    const current = await vault.read('race.md', 64);
    assert.equal(current.revision, results.find(result => result.status === 'fulfilled').value);
    assert.equal(loser.reason.currentRevision, current.revision);
  });

  it('commits only one replacement when simultaneous saves carry the same revision', async t => {
    const { root, vault } = await isolatedVault(t);
    const revision = await vault.create('race.md', 'original', QUERY_LIMITS.maxReadBytes);
    const second = await Vault.open(root);
    const results = await Promise.allSettled([
      vault.save('race.md', 'first', revision, QUERY_LIMITS.maxReadBytes), second.save('race.md', 'second', revision, QUERY_LIMITS.maxReadBytes),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'conflict');
    assert.equal((await vault.read('race.md', 64)).revision, results.find(result => result.status === 'fulfilled').value);
  });

  it('preserves every simultaneous append and reports the committed revision chain', async t => {
    const { root, vault } = await isolatedVault(t);
    const initial = await vault.create('append.md', 'start', QUERY_LIMITS.maxReadBytes);
    const writers = await Promise.all(Array.from({ length: 4 }, () => Vault.open(root)));
    const changes = await Promise.all(writers.map((writer, index) => writer.append('append.md', `line ${index}`, 256)));
    const note = await vault.read('append.md', 256);
    assert.deepEqual(note.text.split('\n').sort(), ['start', 'line 0', 'line 1', 'line 2', 'line 3'].sort());
    const revisions = new Set([initial, ...changes.map(change => change.revision)]);
    assert.equal(revisions.size, 5);
    for (const change of changes) assert.ok(revisions.has(change.previousRevision));
    assert.ok(changes.some(change => change.revision === note.revision));
  });

  it('rejects a common external edit made after the caller read its revision', async t => {
    const { root, vault } = await isolatedVault(t);
    const revision = await vault.create('external.md', 'original', QUERY_LIMITS.maxReadBytes);
    await writeFile(join(root, 'external.md'), 'external replacement');
    await assert.rejects(vault.save('external.md', 'stale caller', revision, QUERY_LIMITS.maxReadBytes), rejects('conflict'));
    assert.equal(await readFile(join(root, 'external.md'), 'utf8'), 'external replacement');
  });

  it('leaves the previous file intact when the filesystem rejects atomic staging', async t => {
    if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('This case requires enforced POSIX directory permissions.'); return; }
    const { root, vault } = await isolatedVault(t);
    const revision = await vault.create('readonly/note.md', 'preserved', QUERY_LIMITS.maxReadBytes);
    const directory = join(root, 'readonly');
    await chmod(directory, 0o500);
    try {
      await assert.rejects(vault.save('readonly/note.md', 'lost', revision, QUERY_LIMITS.maxReadBytes), rejects('storage_unavailable'));
      assert.equal(await readFile(join(directory, 'note.md'), 'utf8'), 'preserved');
      assert.deepEqual(await readdir(directory), ['note.md']);
    } finally { await chmod(directory, 0o700); }
  });

  it('serializes independent Node processes against the same vault revision', { timeout: 30000 }, async t => {
    const { root, vault } = await isolatedVault(t);
    const revision = await vault.create('process.md', 'original', QUERY_LIMITS.maxReadBytes);
    const source = `import { Vault } from ${JSON.stringify(new URL('../src/vault.ts', import.meta.url).href)};
const vault = await Vault.open(process.env.NOTES_TEST_ROOT);
process.once('message', async () => {
  try { await vault.save('process.md', process.env.NOTES_TEST_TEXT, process.env.NOTES_TEST_REVISION, 262144); process.send({ result: 'saved' }); }
  catch (error) { process.send({ result: error.code ?? 'unexpected' }); }
  process.disconnect();
});
process.send({ ready: true });`;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(name)));
    const workers = ['first process', 'second process'].map(text => {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', source], {
        env: { ...environment, NOTES_TEST_ROOT: root, NOTES_TEST_TEXT: text, NOTES_TEST_REVISION: revision },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
      });
      const exited = once(child, 'exit');
      const ready = Promise.race([once(child, 'message'), exited.then(([code]) => { throw new Error(`Vault worker exited before ready (${code}).`); })]);
      t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
      return { child, ready, exited };
    });
    await Promise.all(workers.map(worker => worker.ready));
    const outcomes = workers.map(worker => Promise.race([once(worker.child, 'message'), worker.exited.then(([code]) => { throw new Error(`Vault worker exited before result (${code}).`); })]));
    for (const worker of workers) worker.child.send('save');
    const results = await Promise.all(outcomes);
    assert.deepEqual(results.map(([value]) => value.result).sort(), ['conflict', 'saved']);
    for (const worker of workers) assert.equal((await worker.exited)[0], 0);
    assert.ok(['first process', 'second process'].includes((await vault.read('process.md', 64)).text));
  });
});

describe('bounded note IO', () => {
  it('enforces the byte budget when an external writer grows the file after the size check', async t => {
    const { root, vault } = await isolatedVault(t);
    const path = join(root, 'growing.md');
    await writeFile(path, 'small');
    const probe = await open(path, 'r');
    const prototype = Object.getPrototypeOf(probe);
    const original = prototype.createReadStream;
    await probe.close();
    let changed = false;
    t.mock.method(prototype, 'createReadStream', function (options) {
      if (!changed) { changed = true; writeFileSync(path, 'x'.repeat(128)); }
      return original.call(this, options);
    });
    await assert.rejects(vault.read('growing.md', 16), rejects('invalid_request'));
    assert.equal(changed, true);
  });

  it('refuses a sparse large file before reading its body', async t => {
    const { root, vault } = await isolatedVault(t);
    const handle = await open(join(root, 'large.md'), 'w');
    try { await handle.truncate(64 * 1024 * 1024); } finally { await handle.close(); }
    await assert.rejects(vault.read('large.md', 64), rejects('invalid_request'));
    await assert.rejects(vault.list({ maxReadBytes: 64, maxTreeEntries: 10 }), rejects('invalid_request'));
    await assert.rejects(vault.append('large.md', 'append', 64), rejects('invalid_request'));
    await assert.rejects(vault.appendOrCreate('large.md', 'append', 'initial', 64), rejects('invalid_request'));
  });

  it('stops a bounded listing when another visible note exceeds its entry budget', async t => {
    const { vault } = await isolatedVault(t);
    await vault.create('a.md', 'a', QUERY_LIMITS.maxReadBytes);
    await vault.create('b.md', 'b', QUERY_LIMITS.maxReadBytes);
    await assert.rejects(vault.list({ maxReadBytes: 64, maxTreeEntries: 1 }), rejects('invalid_request'));
  });
});
