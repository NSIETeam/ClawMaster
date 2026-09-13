/** Proposal metadata uses the vault's path checks, atomic publication, and configured bounds. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promises as fs, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProposalStore, PROPOSAL_DIRECTORY } from '../src/proposals.ts';
import { Vault, VaultError, revisionOf } from '../src/vault.ts';

const ID = '00000000-0000-4000-8000-000000000000';
const rejects = code => error => error instanceof VaultError && error.code === code;
const record = text => ({ proposalId: ID, id: 'a.md', text, baseRevision: null, createdAt: '2026-09-13T00:00:00.000Z' });
const serialized = text => `${JSON.stringify(record(text))}\n`;

async function fixture(t, maxReadBytes = 4096, maxEntries = 10) {
  const parent = await fs.mkdtemp(join(tmpdir(), 'clawmaster-proposal-security-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 3 }));
  const vault = await Vault.open(join(parent, 'vault'));
  return { parent, root: vault.root, vault, store: new ProposalStore(vault, maxReadBytes, maxEntries) };
}

describe('proposal metadata paths', () => {
  for (const component of ['.clawmaster', PROPOSAL_DIRECTORY]) {
    it(`refuses the linked ${component} directory for reads, creation, listing and discard`, async t => {
      const { parent, root, store } = await fixture(t);
      const outside = join(parent, 'outside');
      const target = component === '.clawmaster' ? join(outside, 'proposals') : outside;
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(join(target, `${ID}.json`), serialized('outside sentinel'));
      if (component !== '.clawmaster') await fs.mkdir(join(root, '.clawmaster'));
      await fs.symlink(outside, join(root, component), 'junction');
      for (const action of [() => store.create('a.md', 'changed'), () => store.read(ID), () => store.list(), () => store.remove(ID)]) {
        await assert.rejects(action, rejects('invalid_path'));
      }
      assert.equal(await fs.readFile(join(target, `${ID}.json`), 'utf8'), serialized('outside sentinel'));
      assert.deepEqual(await fs.readdir(target), [`${ID}.json`]);
    });
  }

  it('refuses linked proposal files without reading, removing or replacing the target', async t => {
    const { parent, root, vault, store } = await fixture(t);
    const outside = join(parent, 'outside.json');
    await fs.writeFile(outside, serialized('outside sentinel'));
    await fs.mkdir(join(root, PROPOSAL_DIRECTORY), { recursive: true });
    try { await fs.symlink(outside, join(root, PROPOSAL_DIRECTORY, `${ID}.json`), 'file'); } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows account cannot create file symlinks; directory junction coverage still runs.'); return; }
      throw error;
    }
    for (const action of [() => store.read(ID), () => store.list(), () => store.remove(ID),
      () => vault.createMetadata('proposals', `${ID}.json`, serialized('changed'), 4096)]) {
      await assert.rejects(action, rejects('invalid_path'));
    }
    assert.equal(await fs.readFile(outside, 'utf8'), serialized('outside sentinel'));
    assert.equal((await fs.lstat(join(root, PROPOSAL_DIRECTORY, `${ID}.json`))).isSymbolicLink(), true);
  });

  it('refuses a directory disguised as a JSON file and preserves its contents', async t => {
    const { root, store } = await fixture(t);
    const directory = join(root, PROPOSAL_DIRECTORY, `${ID}.json`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, 'sentinel'), 'preserved');
    for (const action of [() => store.read(ID), () => store.list(), () => store.remove(ID)]) await assert.rejects(action, rejects('invalid_path'));
    assert.equal(await fs.readFile(join(directory, 'sentinel'), 'utf8'), 'preserved');
  });

  it('keeps hidden metadata inaccessible through note ids and rejects metadata traversal', async t => {
    const { vault, store } = await fixture(t);
    await store.create('a.md', 'private draft');
    assert.deepEqual(await vault.list({ maxReadBytes: 4096, maxTreeEntries: 10 }), []);
    await assert.rejects(vault.read('.clawmaster/proposals/a.json', 4096), rejects('invalid_path'));
    await assert.rejects(vault.readMetadata('../outside', `${ID}.json`, 4096), rejects('invalid_path'));
    await assert.rejects(vault.createMetadata('proposals', '../outside.json', 'x', 4096), rejects('invalid_path'));
  });
});

describe('proposal metadata publication', () => {
  it('publishes complete private JSON only after staging finishes', { timeout: 30000 }, async t => {
    const { root, store } = await fixture(t);
    const original = fs.link;
    let entered, release;
    const staged = new Promise(resolve => { entered = resolve; });
    const commit = new Promise(resolve => { release = resolve; });
    t.mock.method(fs, 'link', async (source, destination) => {
      entered(destination);
      await commit;
      return original(source, destination);
    });
    syncBuiltinESMExports();
    const pending = store.create('a.md', 'complete draft');
    try {
      const destination = await Promise.race([staged, pending.then(() => { throw new Error('Publication completed before the staging barrier.'); })]);
      await assert.rejects(fs.readFile(destination), error => error.code === 'ENOENT');
      assert.deepEqual(await store.list(), []);
      release();
      const proposal = await pending;
      assert.deepEqual(await store.read(proposal.proposalId), proposal);
      assert.deepEqual(await fs.readdir(join(root, PROPOSAL_DIRECTORY)), [`${proposal.proposalId}.json`]);
      if (process.platform !== 'win32') {
        assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(join(root, PROPOSAL_DIRECTORY))).mode & 0o777, 0o700);
      }
    } finally {
      release();
      await pending.catch(() => {}); // Await the owned writer before restoring its intercepted publication call.
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it('commits one complete record when two vault writers claim the same metadata filename', async t => {
    const { root, vault, store } = await fixture(t);
    const second = await Vault.open(root);
    const results = await Promise.allSettled([vault, second].map((writer, index) =>
      writer.createMetadata('proposals', `${ID}.json`, serialized(`writer ${index}`), 4096)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const stored = await store.read(ID);
    const revision = revisionOf(serialized(stored.text));
    assert.equal(results.find(result => result.status === 'fulfilled').value, revision);
    const conflict = results.find(result => result.status === 'rejected').reason;
    assert.equal(conflict.code, 'conflict');
    assert.equal(conflict.currentRevision, revision);
  });

  it('preserves existing drafts and leaves no partial proposal when atomic staging is denied', async t => {
    if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('This case requires enforced POSIX directory permissions.'); return; }
    const { root, store } = await fixture(t);
    const proposal = await store.create('a.md', 'preserved');
    const directory = join(root, PROPOSAL_DIRECTORY);
    await fs.chmod(directory, 0o500);
    try {
      await assert.rejects(store.create('b.md', 'not published'), rejects('storage_unavailable'));
      assert.deepEqual(await store.read(proposal.proposalId), proposal);
      assert.deepEqual(await fs.readdir(directory), [`${proposal.proposalId}.json`]);
    } finally { await fs.chmod(directory, 0o700); }
  });
});

describe('proposal metadata bounds and validation', () => {
  it('rejects oversized creation before it creates metadata directories', async t => {
    const { root, store } = await fixture(t, 512);
    await assert.rejects(store.create('a.md', 'x'.repeat(512)), rejects('invalid_request'));
    await assert.rejects(fs.lstat(join(root, '.clawmaster')), error => error.code === 'ENOENT');
  });

  it('rejects oversized files in direct reads and listings before parsing JSON', async t => {
    const { root, store } = await fixture(t, 512);
    await fs.mkdir(join(root, PROPOSAL_DIRECTORY), { recursive: true });
    const handle = await fs.open(join(root, PROPOSAL_DIRECTORY, `${ID}.json`), 'w');
    try { await handle.truncate(8 * 1024 * 1024); } finally { await handle.close(); }
    await assert.rejects(store.read(ID), rejects('invalid_request'));
    await assert.rejects(store.list(), rejects('invalid_request'));
  });

  it('enforces the byte bound when a proposal grows after the initial stat', async t => {
    const { root, store } = await fixture(t, 512);
    const proposal = await store.create('a.md', 'small');
    const path = join(root, PROPOSAL_DIRECTORY, `${proposal.proposalId}.json`);
    const probe = await fs.open(path, 'r');
    const prototype = Object.getPrototypeOf(probe);
    const original = prototype.createReadStream;
    await probe.close();
    let grew = false;
    t.mock.method(prototype, 'createReadStream', function (options) {
      if (!grew) { grew = true; writeFileSync(path, 'x'.repeat(1024)); }
      return original.call(this, options);
    });
    try { await assert.rejects(store.read(proposal.proposalId), rejects('invalid_request')); }
    finally { t.mock.restoreAll(); }
    assert.equal(grew, true);
  });

  it('bounds every enumerated metadata entry and does not hide an exceeded budget', async t => {
    const { root, vault, store } = await fixture(t);
    await store.create('a.md', 'one');
    await fs.writeFile(join(root, PROPOSAL_DIRECTORY, 'unrelated.txt'), 'not a proposal');
    const bounded = new ProposalStore(vault, 4096, 1);
    await assert.rejects(bounded.list(), rejects('invalid_request'));
  });

  it('shares one JSON byte budget across individually readable proposals', async t => {
    const { vault, store } = await fixture(t);
    const first = await store.create('a.md', 'x'.repeat(160));
    const second = await store.create('b.md', 'y'.repeat(160));
    const bounded = new ProposalStore(vault, 512, 10);
    assert.equal((await bounded.read(first.proposalId)).text.length, 160);
    assert.equal((await bounded.read(second.proposalId)).text.length, 160);
    await assert.rejects(bounded.list(), rejects('invalid_request'));
  });

  it('rejects malformed JSON, changed record identities and invalid base revisions', async t => {
    const { root, store } = await fixture(t);
    await fs.mkdir(join(root, PROPOSAL_DIRECTORY), { recursive: true });
    const path = join(root, PROPOSAL_DIRECTORY, `${ID}.json`);
    for (const text of ['{truncated', JSON.stringify({ ...record('x'), proposalId: '11111111-1111-4111-8111-111111111111' }),
      JSON.stringify({ ...record('x'), baseRevision: 'stale' })]) {
      await fs.writeFile(path, text);
      await assert.rejects(store.read(ID), rejects('storage_unavailable'));
      await assert.rejects(store.list(), rejects('storage_unavailable'));
    }
  });
});
