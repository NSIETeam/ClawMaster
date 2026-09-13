/**
 * Artifact-plane check: load the SHIPPED dist/index.js, not the TypeScript source.
 * Guards the class of defect where a deployed bundle is not built from current source.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTES_COMMAND_PATH, NOTES_TREE_PATH } from '../src/protocol.ts';

const shipped = await import('../dist/index.js');

function harness() {
  const routes = new Map();
  const tools = new Map();
  let install;
  let answer = 'allowed-once';
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => { tools.delete(definition.name); }; } },
    approval: { async request() { return answer; } },
    effect(operation) { install = operation(); return install; },
  };
  return { ctx, routes, tools, deny() { answer = 'denied'; }, async dispose() { const remove = await install; await remove(); } };
}

async function withArtifact(run) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-artifact-'));
  const host = harness();
  try {
    await shipped.apply(host.ctx, { vaultRoot: root });
    return await run(host, root);
  } finally { await host.dispose(); await rm(root, { recursive: true, force: true }); }
}

const command = body => new Request(`http://localhost${NOTES_COMMAND_PATH}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('shipped artifact', () => {
  it('exports the plugin surface the loader expects', () => {
    assert.equal(shipped.name, 'clawmaster-notes');
    assert.deepEqual(shipped.inject, ['connection', 'tools', 'approval']);
    assert.equal(typeof shipped.apply, 'function');
    assert.equal(typeof shipped.defaultVaultRoot, 'function');
  });

  it('registers every Notes route and seeds a fresh vault', async () => withArtifact(async host => {
    assert.deepEqual([...host.routes.keys()].sort(), [
      '/api/clawmaster/notes/backlinks',
      '/api/clawmaster/notes/command', '/api/clawmaster/notes/note',
      '/api/clawmaster/notes/proposals', '/api/clawmaster/notes/revision',
      '/api/clawmaster/notes/search', '/api/clawmaster/notes/tags', '/api/clawmaster/notes/tree',
    ]);
    const response = await host.routes.get(NOTES_TREE_PATH).fetch(new Request(`http://localhost${NOTES_TREE_PATH}`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).notes.map(note => note.id), ['欢迎.md']);
  }));

  it('returns JSON from every built route, including both live-refresh endpoints', async () => withArtifact(async host => {
    const prefix = '/api/clawmaster/notes/';
    for (const [path, query] of [
      ['tree', ''], ['note', '?id=' + encodeURIComponent('欢迎.md')], ['search', '?q=ClawMaster'],
      ['tags', ''], ['backlinks', '?id=' + encodeURIComponent('欢迎.md')], ['proposals', ''], ['revision', ''],
    ]) {
      const response = await host.routes.get(prefix + path).fetch(new Request('http://localhost' + prefix + path + query));
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), /application\/json/, path);
      assert.equal(typeof await response.json(), 'object', path);
    }
    const invalid = await host.routes.get(NOTES_COMMAND_PATH).fetch(command({ request: { action: 'missing' } }));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'invalid_request');
    const missing = await host.routes.get(prefix + 'note').fetch(new Request('http://localhost' + prefix + 'note?id=missing.md'));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'not_found');
  }));

  it('commits an approved daily entry to disk', async () => withArtifact(async (host, root) => {
    const write = host.tools.get('notes_write');
    const receipt = await write.execute(
      { request: { action: 'daily', text: '完成笔记模块并验证产物', date: '2026-09-13' } },
      { name: 'notes_write', callId: 'c1', agent: { id: 'agent' }, signal: new AbortController().signal },
    );
    assert.equal(receipt.id, '日记/2026-09-13.md');
    const text = await readFile(join(root, receipt.id), 'utf8');
    assert.match(text, /完成笔记模块并验证产物/);
  }));

  it('writes nothing when approval is denied', async () => withArtifact(async host => {
    host.deny();
    const write = host.tools.get('notes_write');
    await assert.rejects(
      write.execute({ request: { action: 'create', id: 'x.md', text: 'x' } },
        { name: 'notes_write', callId: 'c', agent: {}, signal: new AbortController().signal }),
      /approval_denied/,
    );
    const listed = await (await host.routes.get(NOTES_TREE_PATH).fetch(new Request(`http://localhost${NOTES_TREE_PATH}`))).json();
    assert.ok(!listed.notes.some(note => note.id === 'x.md'));
  }));

  it('withdraws its routes and tools on disposal', async () => withArtifact(async host => {
    await host.routes.get(NOTES_COMMAND_PATH).fetch(command({ request: { action: 'create', id: 'a.md', text: 'a' } }));
    await host.dispose();
    assert.equal(host.routes.size, 0);
    assert.equal(host.tools.size, 0);
  }));
});


it('changes the built revision for a proposal and its discard without editing a note', async () => withArtifact(async (host, root) => {
  const prefix = '/api/clawmaster/notes/';
  const get = async path => (await host.routes.get(prefix + path).fetch(new Request('http://localhost' + prefix + path))).json();
  const source = await readFile(join(root, '欢迎.md'), 'utf8');
  const before = (await get('revision')).version;
  const drafted = await host.tools.get('notes_propose').execute(
    { id: '欢迎.md', text: 'pending draft only' },
    { name: 'notes_propose', callId: 'proposal', agent: {}, signal: new AbortController().signal },
  );
  const pending = await get('proposals');
  assert.equal(pending.proposals.length, 1);
  const after = (await get('revision')).version;
  assert.notEqual(after, before);
  assert.equal(await readFile(join(root, '欢迎.md'), 'utf8'), source);
  const discarded = await host.routes.get(NOTES_COMMAND_PATH).fetch(command({ request: { action: 'discard-proposal', proposalId: drafted.proposal.proposalId } }));
  assert.equal(discarded.status, 200);
  assert.deepEqual((await get('proposals')).proposals, []);
  assert.equal((await get('revision')).version, before);
  assert.equal(await readFile(join(root, '欢迎.md'), 'utf8'), source);
}));
