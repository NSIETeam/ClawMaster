/** Notes host: route contract, error mapping, approval gating and the tool surface. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTES_ANNOTATIONS_PATH, NOTES_BACKLINKS_PATH, NOTES_COMMAND_PATH, NOTES_NOTE_PATH, NOTES_PROPOSALS_PATH, NOTES_REVISION_PATH, NOTES_SEARCH_PATH, NOTES_TAGS_PATH, NOTES_TREE_PATH } from '../src/protocol.ts';
import { apply, defaultVaultRoot, requestTextOf, runQuery } from '../src/host.ts';
import { NotesService } from '../src/service.ts';
import { Vault } from '../src/vault.ts';

/** A minimal stand-in for the DSH Fetch, tool and approval services. */
function harness() {
  const routes = new Map();
  const tools = new Map();
  const prompts = [];
  const provided = new Map();
  const listeners = new Map();
  const warnings = [];
  let install;
  let answer = 'allowed-once';
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => { tools.delete(definition.name); }; } },
    approval: { async request(request) { prompts.push(request); return answer; } },
    effect(operation) { install = operation(); return install; },
    provide(key, value) { provided.set(key, value); },
    get(key) { return provided.get(key); },
    on(event, listener) { listeners.set(event, listener); return () => { listeners.delete(event); }; },
    logger: { warn(message) { warnings.push(message); } },
  };
  return {
    ctx, routes, tools, prompts, provided, listeners, warnings,
    deny() { answer = 'denied'; },
    allow() { answer = 'allowed-once'; },
    async dispose() { const remove = await install; await remove(); },
  };
}

async function withHost(run, config = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'clawmaster-host-')));
  const host = harness();
  try {
    await apply(host.ctx, { vaultRoot: root, ...config });
    return await run(host, root);
  } finally { await host.dispose(); await rm(root, { recursive: true, force: true }); }
}

const get = path => new Request(`http://localhost${path}`, { method: 'GET' });
const post = (path, body, contentType = 'application/json') => new Request(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': contentType }, body,
});
/** POST one JSON value, the shape every notes command route expects. */
const postJson = (path, value) => post(path, JSON.stringify(value));

describe('default vault root', () => {
  it('is a real documents folder, never runtime state', () => {
    const home = join(tmpdir(), 'clawmaster-default-vault-user');
    assert.equal(defaultVaultRoot('darwin', home), join(home, 'Documents', 'ClawMaster 笔记'));
    assert.equal(defaultVaultRoot('linux', home), join(home, 'ClawMasterNotes'));
    assert.equal(defaultVaultRoot('win32', home), join(home, 'ClawMasterNotes'));
    for (const platform of ['darwin', 'linux', 'win32']) {
      const value = defaultVaultRoot(platform, home);
      assert.ok(!value.includes('.dsh'));
      assert.ok(!value.includes('harness-versions'));
    }
  });

  it('refuses a relative vault root instead of writing somewhere unexpected', async () => {
    const host = harness();
    await assert.rejects(apply(host.ctx, { vaultRoot: 'relative/vault' }), /absolute path/);
  });
});

describe('route contract', () => {
  it('registers notes routes with the right methods', async () => withHost(async host => {
    assert.deepEqual([...host.routes.keys()].sort(),
      [NOTES_ANNOTATIONS_PATH, NOTES_BACKLINKS_PATH, NOTES_COMMAND_PATH, NOTES_NOTE_PATH, NOTES_PROPOSALS_PATH, NOTES_REVISION_PATH, NOTES_SEARCH_PATH, NOTES_TAGS_PATH, NOTES_TREE_PATH].sort());
    for (const route of host.routes.values()) assert.equal(route.requestBody, 'buffered');
    assert.deepEqual(host.routes.get(NOTES_TREE_PATH).methods, ['GET']);
    assert.deepEqual(host.routes.get(NOTES_NOTE_PATH).methods, ['GET']);
    assert.deepEqual(host.routes.get(NOTES_SEARCH_PATH).methods, ['GET']);
    assert.deepEqual(host.routes.get(NOTES_TAGS_PATH).methods, ['GET']);
    assert.deepEqual(host.routes.get(NOTES_COMMAND_PATH).methods, ['POST']);
    assert.deepEqual(host.routes.get(NOTES_BACKLINKS_PATH).methods, ['GET']);
    assert.deepEqual(host.routes.get(NOTES_REVISION_PATH).methods, ['GET']);
    assert.deepEqual(host.routes.get(NOTES_PROPOSALS_PATH).methods, ['GET']);
    assert.deepEqual(host.routes.get(NOTES_ANNOTATIONS_PATH).methods, ['GET', 'POST']);
  }));

  it('serves the tree and seeds a fresh vault', async () => withHost(async (host, root) => {
    const response = await host.routes.get(NOTES_TREE_PATH).fetch(get(NOTES_TREE_PATH));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.vault, root);
    assert.deepEqual(body.notes.map(note => note.id), ['欢迎.md']);
  }));

  it('serves one note and reports a missing one as 404', async () => withHost(async host => {
    await host.routes.get(NOTES_COMMAND_PATH).fetch(
      post(NOTES_COMMAND_PATH, JSON.stringify({ request: { action: 'create', id: 'a.md', text: '# A\n' } })),
    );
    const route = host.routes.get(NOTES_NOTE_PATH);
    const found = await route.fetch(get(`${NOTES_NOTE_PATH}?id=${encodeURIComponent('a.md')}`));
    assert.equal(found.status, 200);
    assert.equal((await found.json()).title, 'A');

    const missing = await route.fetch(get(`${NOTES_NOTE_PATH}?id=missing.md`));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'not_found');
  }));

  it('rejects an invalid note id as 400 without touching the vault', async () => withHost(async host => {
    const response = await host.routes.get(NOTES_NOTE_PATH).fetch(get(`${NOTES_NOTE_PATH}?id=${encodeURIComponent('../escape.md')}`));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_path');
  }));

  it('serves search results', async () => withHost(async host => {
    await host.routes.get(NOTES_COMMAND_PATH).fetch(post(NOTES_COMMAND_PATH, JSON.stringify({
      request: { action: 'create', id: 'a.md', text: '# A\n\n含有关键词的行\n' },
    })));
    const response = await host.routes.get(NOTES_SEARCH_PATH).fetch(get(`${NOTES_SEARCH_PATH}?q=${encodeURIComponent('关键词')}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.matches.map(match => match.id), ['a.md']);
  }));

  it('returns actual backlinks without unrelated notes', async () => withHost(async host => {
    const route = host.routes.get(NOTES_COMMAND_PATH);
    for (const [id, text] of [['Target.md', '# Target\n'], ['Linked.md', '[[Target]]\n'], ['Other.md', 'unrelated\n']]) {
      const response = await route.fetch(post(NOTES_COMMAND_PATH, JSON.stringify({ request: { action: 'create', id, text } })));
      assert.equal(response.status, 200);
    }
    const response = await host.routes.get(NOTES_BACKLINKS_PATH).fetch(get(`${NOTES_BACKLINKS_PATH}?id=Target.md`));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.id, 'Target.md');
    assert.deepEqual(result.notes.map(note => note.id), ['Linked.md']);
  }));

  it('serves tag counts', async () => withHost(async host => {
    await host.routes.get(NOTES_COMMAND_PATH).fetch(post(NOTES_COMMAND_PATH, JSON.stringify({
      request: { action: 'create', id: 'a.md', text: '---\ntags: [工作]\n---\n#工作\n' },
    })));
    const response = await host.routes.get(NOTES_TAGS_PATH).fetch(get(NOTES_TAGS_PATH));
    assert.equal(response.status, 200);
    // A fresh vault is seeded with 欢迎.md, whose head carries the clawmaster tag.
    assert.deepEqual((await response.json()).tags, [
      { tag: 'clawmaster', count: 1 },
      { tag: '工作', count: 1 },
    ]);
  }));

  it('refuses a non-JSON body and malformed JSON', async () => withHost(async host => {
    const route = host.routes.get(NOTES_COMMAND_PATH);
    const wrongType = await route.fetch(post(NOTES_COMMAND_PATH, 'request', 'text/plain'));
    assert.equal(wrongType.status, 400);
    assert.equal((await wrongType.json()).error.message, 'Notes commands require application/json.');

    const malformed = await route.fetch(post(NOTES_COMMAND_PATH, '{not json'));
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.message, 'Notes command JSON is malformed.');
  }));

  it('reports a stale save as 409 with the current revision', async () => withHost(async host => {
    const route = host.routes.get(NOTES_COMMAND_PATH);
    const created = await (await route.fetch(post(NOTES_COMMAND_PATH, JSON.stringify({ request: { action: 'create', id: 'a.md', text: '一' } })))).json();
    const conflict = await route.fetch(post(NOTES_COMMAND_PATH, JSON.stringify({
      request: { action: 'save', id: 'a.md', text: '二', expectedRevision: `sha256-${'0'.repeat(64)}` },
    })));
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.error.code, 'conflict');
    assert.equal(body.error.currentRevision, created.revision);
  }));

  it('stops serving after disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawmaster-host-'));
    try {
      const host = harness();
      await apply(host.ctx, { vaultRoot: root });
      const route = host.routes.get(NOTES_TREE_PATH);
      await host.dispose();
      assert.equal(host.routes.size, 0);
      assert.equal(host.tools.size, 0);
      assert.equal((await route.fetch(get(NOTES_TREE_PATH))).status, 503);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('tool surface', () => {
  for (const [name, args, id] of [
    ['notes_write', { request: { action: 'create', id: 'late.md', text: 'must not be written' } }, 'late.md'],
    ['notes_digest', { summary: 'must not be written', date: '2026-09-13' }, '日记/2026-09-13.md'],
  ]) {
    it(`cancels an outstanding ${name} approval and refuses its late allow after unloading`, async () => withHost(async (host, root) => {
      const requested = Promise.withResolvers();
      const answer = Promise.withResolvers();
      host.ctx.approval.request = request => { requested.resolve(request); return answer.promise; };
      const operation = host.tools.get(name).execute(args,
        { name, callId: 'late', agent: {}, signal: new AbortController().signal });
      const outcome = operation.then(() => undefined, error => error);
      const request = await requested.promise;
      let completed = false;
      const disposed = host.dispose().then(() => { completed = true; });
      await Promise.resolve();
      assert.equal(request.signal.aborted, true);
      assert.equal(completed, false, 'disposal waits for the outstanding operation');
      answer.resolve('allowed-once');
      assert.match((await outcome).message, /unloaded/);
      await disposed;
      assert.equal(host.tools.size, 0);
      await assert.rejects(readFile(join(root, id)), { code: 'ENOENT' });
    }));
  }

  it('rejects a retained propose tool after unloading without creating metadata', async () => withHost(async (host, root) => {
    const propose = host.tools.get('notes_propose');
    await host.dispose();
    await assert.rejects(propose.execute({ id: 'late.md', text: 'must not be stored' },
      { name: 'notes_propose', callId: 'late-proposal', signal: new AbortController().signal }), /unloaded/);
    await assert.rejects(readFile(join(root, '.clawmaster', 'proposals')), { code: 'ENOENT' });
  }));

  it('waits for an in-flight proposal operation when unloading', async () => withHost(async host => {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    const original = NotesService.prototype.propose;
    NotesService.prototype.propose = async () => { entered.resolve(); await released.promise; return { completed: true }; };
    try {
      const operation = host.tools.get('notes_propose').execute({ id: 'wait.md', text: 'draft' },
        { name: 'notes_propose', callId: 'wait-proposal', signal: new AbortController().signal });
      await entered.promise;
      let completed = false;
      const disposed = host.dispose().then(() => { completed = true; });
      await Promise.resolve();
      assert.equal(completed, false);
      released.resolve();
      assert.deepEqual(await operation, { completed: true });
      await disposed;
      assert.equal(completed, true);
    } finally { released.resolve(); NotesService.prototype.propose = original; }
  }));

  it('withdraws the first tool and every route if later registration fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawmaster-host-failure-'));
    const host = harness();
    const register = host.ctx.tools.register;
    host.ctx.tools.register = definition => {
      if (definition.name === 'notes_write') throw new Error('registration failed');
      return register(definition);
    };
    try {
      await assert.rejects(apply(host.ctx, { vaultRoot: root }), /registration failed/);
      assert.equal(host.tools.size, 0);
      assert.equal(host.routes.size, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('registers one read tool and one write tool', async () => withHost(async host => {
    assert.deepEqual([...host.tools.keys()].sort(), ['notes_annotate', 'notes_digest', 'notes_propose', 'notes_query', 'notes_write']);
    const query = host.tools.get('notes_query');
    assert.equal(query.parameters.type, 'object');
    assert.deepEqual(query.parameters.required, ['mode']);
    assert.equal(query.parameters.additionalProperties, false);
    assert.deepEqual(host.tools.get('notes_write').parameters.required, ['request']);
    assert.deepEqual(host.tools.get('notes_write').output.schema.required, ['action', 'id', 'revision', 'previousRevision']);
  }));

  it('answers reads without approval', async () => withHost(async host => {
    const query = host.tools.get('notes_query');
    const value = await query.execute({ mode: 'tree' }, { name: 'notes_query', callId: 'c1', signal: new AbortController().signal });
    assert.equal(value.vault.endsWith('clawmaster-host-') || value.vault.length > 0, true);
    assert.equal(host.prompts.length, 0, 'reads must never prompt');
    const rendered = query.output.render({ mode: 'tree' }, value);
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /欢迎\.md/);
  }));

  it('refuses to write without an owning agent session', async () => withHost(async host => {
    const write = host.tools.get('notes_write');
    await assert.rejects(
      write.execute({ request: { action: 'create', id: 'a.md', text: 'x' } }, { name: 'notes_write', callId: 'c', signal: new AbortController().signal }),
      /owning DSH agent session/,
    );
    assert.equal(host.prompts.length, 0);
  }));

  it('does not commit when approval is denied', async () => withHost(async (host, root) => {
    host.deny();
    const write = host.tools.get('notes_write');
    await assert.rejects(
      write.execute(
        { request: { action: 'create', id: 'a.md', text: 'x' } },
        { name: 'notes_write', callId: 'c', agent: { id: 'agent' }, signal: new AbortController().signal },
      ),
      /approval_denied/,
    );
    const listed = await (await host.routes.get(NOTES_TREE_PATH).fetch(get(NOTES_TREE_PATH))).json();
    assert.deepEqual(listed.notes.map(note => note.id), ['欢迎.md']);
    assert.equal(host.prompts.length, 1);
    assert.match(host.prompts[0].reason, /Create note a\.md/);
    assert.equal(host.prompts[0].toolName, 'notes_write');
  }));

  it('commits after a one-shot approval and reports a receipt', async () => withHost(async (host, root) => {
    const write = host.tools.get('notes_write');
    const receipt = await write.execute(
      { request: { action: 'create', id: '工作/摘要.md', text: '# 摘要\n' } },
      { name: 'notes_write', callId: 'c', agent: { id: 'agent' }, signal: new AbortController().signal },
    );
    assert.equal(receipt.action, 'create');
    assert.equal(receipt.id, '工作/摘要.md');
    assert.match(receipt.revision, /^sha256-/);
    assert.equal(receipt.previousRevision, null);
    assert.equal(await readFile(join(root, '工作', '摘要.md'), 'utf8'), '# 摘要\n');
  }));

  it('describes a destructive command honestly in the approval reason', async () => withHost(async host => {
    const write = host.tools.get('notes_write');
    await write.execute({ request: { action: 'create', id: 'a.md', text: 'x' } },
      { name: 'notes_write', callId: 'c1', agent: {}, signal: new AbortController().signal });
    await write.execute({ request: { action: 'delete', id: 'a.md' } },
      { name: 'notes_write', callId: 'c2', agent: {}, signal: new AbortController().signal });
    assert.match(host.prompts[1].reason, /not moved to a trash folder/);
  }));
});

describe('proposals and digests', () => {
  const exec = (agent) => ({ name: 'notes', callId: 'c', ...(agent ? { agent } : {}), signal: new AbortController().signal });

  it('drafts a proposal without approval and lists it', async () => withHost(async host => {
    const result = await host.tools.get('notes_propose').execute({ id: 'a.md', text: '# A\nnew line\n' }, exec());
    assert.equal(result.proposal.id, 'a.md');
    assert.equal(result.proposal.baseRevision, null);
    assert.equal(result.diff.added, 2);
    assert.equal(host.prompts.length, 0, 'drafting a proposal must never prompt');
    const listed = await (await host.routes.get(NOTES_PROPOSALS_PATH).fetch(get(NOTES_PROPOSALS_PATH))).json();
    assert.equal(listed.proposals.length, 1);
    assert.equal(listed.proposals[0].proposal.proposalId, result.proposal.proposalId);
    const viaQuery = await host.tools.get('notes_query').execute({ mode: 'proposals' }, exec());
    assert.equal(viaQuery.proposals.length, 1);
  }));

  it('applies a proposal only after a one-shot approval', async () => withHost(async (host, root) => {
    const { proposal } = await host.tools.get('notes_propose').execute({ id: 'a.md', text: '# A\n' }, exec());
    const receipt = await host.tools.get('notes_write').execute(
      { request: { action: 'apply-proposal', proposalId: proposal.proposalId } }, exec({ id: 'agent' }),
    );
    assert.equal(receipt.id, 'a.md');
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# A\n');
    assert.equal(host.prompts.length, 1);
    assert.match(host.prompts[0].reason, /Apply the stored proposal/);
    const listed = await (await host.routes.get(NOTES_PROPOSALS_PATH).fetch(get(NOTES_PROPOSALS_PATH))).json();
    assert.deepEqual(listed.proposals, [], 'an applied proposal is gone');
  }));

  it('records work in the daily note through notes_digest', async () => withHost(async (host, root) => {
    const result = await host.tools.get('notes_digest').execute(
      { summary: '修完 A1', date: '2026-09-13', time: '16:40', nextSteps: ['补文档'] }, exec({ id: 'agent' }),
    );
    assert.equal(result.id, '日记/2026-09-13.md');
    const text = await readFile(join(root, result.id), 'utf8');
    assert.match(text, /### 16:40/);
    assert.match(text, /修完 A1/);
    assert.match(text, /\*\*下一步\*\*/);
    assert.equal(host.prompts.length, 1);
    assert.match(host.prompts[0].reason, /Append a work entry/);
  }));

  it('refuses a digest without an owning agent session', async () => withHost(async host => {
    await assert.rejects(host.tools.get('notes_digest').execute({ summary: 'x' }, exec()), /owning DSH agent session/);
    assert.equal(host.prompts.length, 0);
  }));

  it('publishes the vault access companion plugins run through', async () => withHost(async (host, root) => {
    const access = host.provided.get('clawmasterNotes');
    assert.ok(access, 'the notes host must publish its vault access');
    assert.equal(access.root, root);
    await readFile(join(root, '欢迎.md'), 'utf8');

    assert.equal((await access.list()).some(entry => entry.id === '欢迎.md'), true);
    assert.match((await access.read('欢迎.md')).text, /ClawMaster/);
    assert.equal((await access.search('ClawMaster')).length >= 1, true);
    assert.equal(Array.isArray(await access.tags()), true);

    // A digest written through the access object lands in the same daily note the agent tool uses.
    const receipt = await access.digest({ date: '2026-09-14', time: '16:45', summary: '通过访问句柄归档' });
    assert.equal(receipt.id, '日记/2026-09-14.md');
    assert.match(receipt.revision, /^sha256-[0-9a-f]{64}$/);
    assert.match(await readFile(join(root, '日记/2026-09-14.md'), 'utf8'), /通过访问句柄归档/);
  }));

  it('marks a note through the route, reads it back and removes it', async () => withHost(async host => {
    const route = host.routes.get(NOTES_ANNOTATIONS_PATH);
    const empty = await (await route.fetch(get(NOTES_ANNOTATIONS_PATH))).json();
    assert.deepEqual(empty.annotations, []);

    const added = await route.fetch(postJson(NOTES_ANNOTATIONS_PATH, {
      request: { action: 'add', annotation: { id: '欢迎.md', body: '先看这一行', kind: 'highlight', source: 'human', author: 'king', line: 1 } },
    }));
    assert.equal(added.status, 200);
    const receipt = await added.json();
    assert.equal(receipt.action, 'add');
    assert.equal(receipt.annotation.source, 'human');
    assert.equal(host.prompts.length, 0, 'an authenticated UI command is a user edit, not an agent approval');

    const listed = await (await route.fetch(get(`${NOTES_ANNOTATIONS_PATH}?id=${encodeURIComponent('欢迎.md')}`))).json();
    assert.equal(listed.id, '欢迎.md');
    assert.deepEqual(listed.annotations.map(annotation => annotation.body), ['先看这一行']);

    const removed = await (await route.fetch(postJson(NOTES_ANNOTATIONS_PATH, {
      request: { action: 'remove', annotationId: receipt.annotation.annotationId },
    }))).json();
    assert.equal(removed.action, 'remove');
    assert.deepEqual((await (await route.fetch(get(NOTES_ANNOTATIONS_PATH))).json()).annotations, []);
  }));

  it('maps a malformed, unknown or orphaned annotation request onto its status', async () => withHost(async host => {
    const route = host.routes.get(NOTES_ANNOTATIONS_PATH);
    assert.equal((await route.fetch(post(NOTES_ANNOTATIONS_PATH, 'annotation', 'text/plain'))).status, 400);
    assert.equal((await route.fetch(new Request(`http://localhost${NOTES_ANNOTATIONS_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
    }))).status, 400);
    assert.equal((await route.fetch(postJson(NOTES_ANNOTATIONS_PATH, {
      request: { action: 'remove', annotationId: '00000000-0000-4000-8000-000000000000' },
    }))).status, 404);
    assert.equal((await route.fetch(postJson(NOTES_ANNOTATIONS_PATH, {
      request: { action: 'add', annotation: { id: '不存在.md', body: 'x', kind: 'comment' } },
    }))).status, 404, 'a mark cannot hang on a note that does not exist');
  }));

  it('gates an agent mark behind one approval and reads marks without one', async () => withHost(async host => {
    const tool = host.tools.get('notes_annotate');
    assert.deepEqual(tool.parameters.required, ['action']);
    const call = exec({ session: 's' });

    host.deny();
    await assert.rejects(
      tool.execute({ action: 'add', id: '欢迎.md', body: '被拒绝的批注', kind: 'risk' }, call),
      /approval_denied/,
    );
    assert.equal(host.prompts.length, 1);
    assert.match(host.prompts[0].reason, /Mark note 欢迎\.md as risk/);

    host.allow();
    const receipt = await tool.execute({ action: 'add', id: '欢迎.md', body: '值得注意', kind: 'todo', source: 'ai', author: 'deepseek' }, call);
    assert.equal(receipt.annotation.body, '值得注意');
    assert.equal(receipt.annotation.author, 'deepseek');
    assert.equal(receipt.annotation.line, null);
    assert.equal(host.prompts.length, 2);

    const read = await host.tools.get('notes_query').execute({ mode: 'annotations' }, exec());
    assert.deepEqual(read.annotations.map(annotation => annotation.body), ['值得注意']);
    assert.equal(host.prompts.length, 2, 'reads never prompt');
  }));
});

describe('memory bridge', () => {
  /** One step as the agent waterfall presents it. */
  const step = (payload, agent = {}) => ({ agent, turn: 1, step: 1, signal: new AbortController().signal, ...payload });
  const enter = messages => async () => ({ kind: 'enter', messages });
  const human = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const injected = decision => decision.messages.at(-1);

  it('names a matching note to the model, once per agent', async () => withHost(async host => {
    await host.routes.get(NOTES_COMMAND_PATH)
      .fetch(postJson(NOTES_COMMAND_PATH, { request: { action: 'create', id: '设计/WatchDog 三段审查与笔记系统.md', text: '# WatchDog 三段审查与笔记系统\n' } }));
    const listener = host.listeners.get('agent/pre-step');
    const agent = {};
    const first = await listener(step({ messages: [human('继续做笔记批注面板')] }, agent), enter([human('继续做笔记批注面板')]));
    const block = injected(first);
    assert.equal(first.kind, 'enter');
    assert.equal(first.messages.length, 2);
    assert.equal(block.source.kind, 'plugin');
    assert.equal(block.source.plugin, 'clawmaster-notes');
    assert.equal(block.source.form, 'snapshot');
    assert.match(block.content[0].text, /设计\/WatchDog 三段审查与笔记系统\.md/);

    // The same note is not repeated to the same agent, then a different agent may hear it again.
    const again = await listener(step({ messages: [human('再看一下笔记审查')] }, agent), enter([human('再看一下笔记审查')]));
    assert.equal(again.messages.length, 1);
    const elsewhere = await listener(step({ messages: [human('再看一下笔记审查')] }, {}), enter([human('再看一下笔记审查')]));
    assert.equal(elsewhere.messages.length, 2);
  }, { notesContext: 'related' }));

  it('stays silent for a request that matches no note, for a later step, and for injected text', async () => withHost(async host => {
    const listener = host.listeners.get('agent/pre-step');
    const nomatch = await listener(step({ messages: [human('zzz nothing in the vault')] }), enter([human('zzz nothing in the vault')]));
    assert.equal(nomatch.messages.length, 1);
    const second = await listener(step({ step: 2, messages: [human('欢迎')] }), enter([human('欢迎')]));
    assert.equal(second.messages.length, 1);
    const pluginText = await listener(step({
      messages: [{ role: 'user', source: { kind: 'plugin', plugin: 'other' }, content: [{ type: 'text', text: '欢迎' }] }],
    }), enter([human('欢迎')]));
    assert.equal(pluginText.messages.length, 1);
  }, { notesContext: 'related' }));

  it('respects the note limit and the off switch', async () => withHost(async host => {
    for (const name of ['守卫一', '守卫二', '守卫三']) {
      await host.routes.get(NOTES_COMMAND_PATH)
        .fetch(postJson(NOTES_COMMAND_PATH, { request: { action: 'create', id: `${name}.md`, text: `# ${name}\n` } }));
    }
    const listener = host.listeners.get('agent/pre-step');
    const decision = await listener(step({ messages: [human('守卫')] }), enter([human('守卫')]));
    assert.equal(decision.messages.length, 2);
    assert.equal(decision.messages[1].content[0].text.match(/^- /gm).length, 3);
  }, { notesContext: 'related', maxContextNotes: 3 }));

  it('does not subscribe at all when the bridge is off', async () => withHost(async host => {
    assert.equal(host.listeners.has('agent/pre-step'), false);
  }, { notesContext: 'off' }));

  it('never costs the turn its step when the vault cannot be listed', async () => withHost(async (host, root) => {
    const listener = host.listeners.get('agent/pre-step');
    await rm(root, { recursive: true, force: true });
    const decision = await listener(step({ messages: [human('欢迎')] }), enter([human('欢迎')]));
    assert.equal(decision.messages.length, 1);
    assert.ok(host.warnings.some(message => message.includes('related notes were skipped')));
  }, { notesContext: 'related' }));

  it('reads the human request out of either content shape', async () => {
    assert.equal(requestTextOf([{ source: { kind: 'user' }, content: 'plain' }]), 'plain');
    assert.equal(requestTextOf([{ source: { kind: 'plugin' } }, { source: { kind: 'user' }, content: [{ type: 'text', text: 'blocks' }] }]), 'blocks');
    assert.equal(requestTextOf([{ source: { kind: 'user' }, content: [{ type: 'image' }] }]), undefined);
    assert.equal(requestTextOf([]), undefined);
  });
});

describe('runQuery', () => {
  it('covers every read mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawmaster-query-'));
    try {
      const service = new NotesService(await Vault.open(root));
      await service.execute({ action: 'create', id: 'a.md', text: '---\ntags: [工作]\n---\n# A\n\n见 [[b]]\n' });
      await service.execute({ action: 'create', id: 'b.md', text: '# B\n' });
      assert.equal((await runQuery(service, { mode: 'tree' })).notes.length, 2);
      assert.equal((await runQuery(service, { mode: 'read', id: 'a.md' })).title, 'A');
      assert.equal((await runQuery(service, { mode: 'search', query: 'B' })).matches.length >= 1, true);
      assert.deepEqual((await runQuery(service, { mode: 'backlinks', id: 'b.md' })).notes.map(note => note.id), ['a.md']);
      assert.deepEqual(await runQuery(service, { mode: 'tags' }), { tags: [{ tag: '工作', count: 1 }] });
      await assert.rejects(runQuery(service, { mode: 'nonsense' }));
      await assert.rejects(runQuery(service, { mode: 'read' }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
