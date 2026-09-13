/** Notes transport: request shape, response validation and failure mapping. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NotesApi, NotesApiError } from '../src/notes-api.ts';
import { NOTES_BACKLINKS_PATH, NOTES_COMMAND_PATH, NOTES_NOTE_PATH, NOTES_SEARCH_PATH, NOTES_TREE_PATH } from '../src/protocol.ts';

const revision = `sha256-${'a'.repeat(64)}`;

/** Record every call and reply with a canned response. */
function stub(handler) {
  const calls = [];
  const request = async (path, init) => {
    calls.push({ path, init });
    const { status = 200, body } = handler(path, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, request };
}

describe('requests', () => {
  it('reads validated backlinks through their own route', async () => {
    const { calls, request } = stub(() => ({ body: { id: '目录/Target #.md', notes: [] } }));
    assert.deepEqual(await new NotesApi(request).backlinks('目录/Target #.md'), { id: '目录/Target #.md', notes: [] });
    const url = new URL(calls[0].path, 'http://localhost');
    assert.equal(url.pathname, NOTES_BACKLINKS_PATH);
    assert.equal(url.searchParams.get('id'), '目录/Target #.md');
    assert.equal(calls[0].init.credentials, 'same-origin');
  });

  it('reads the tree with same-origin credentials', async () => {
    const { calls, request } = stub(() => ({ body: { vault: '/v', notes: [] } }));
    assert.deepEqual(await new NotesApi(request).tree(), { vault: '/v', notes: [] });
    assert.equal(calls[0].path, NOTES_TREE_PATH);
    assert.equal(calls[0].init.credentials, 'same-origin');
  });

  it('encodes the note id and search query', async () => {
    const { calls, request } = stub(path => path.startsWith(NOTES_NOTE_PATH)
      ? { body: { id: 'a b.md', title: 't', text: '', revision, links: [], embeds: [], tags: [] } }
      : { body: { query: '关键词', matches: [] } });
    const api = new NotesApi(request);
    await api.read('目录/a b.md');
    await api.search('关键词', 5);
    // Assert round-trip semantics: the host decodes with URL.searchParams, so any
    // standard encoding is acceptable but the value must survive exactly.
    assert.ok(calls[0].path.startsWith(`${NOTES_NOTE_PATH}?`));
    assert.equal(new URLSearchParams(calls[0].path.split('?')[1]).get('id'), '目录/a b.md');
    assert.ok(calls[1].path.startsWith(`${NOTES_SEARCH_PATH}?`));
    const search = new URLSearchParams(calls[1].path.split('?')[1]);
    assert.equal(search.get('q'), '关键词');
    assert.equal(search.get('limit'), '5');
  });

  it('posts a validated command as JSON', async () => {
    const { calls, request } = stub(() => ({ body: { action: 'create', id: 'a.md', revision, previousRevision: null } }));
    const receipt = await new NotesApi(request).command({ action: 'create', id: 'a.md', text: 'x' });
    assert.equal(receipt.revision, revision);
    assert.equal(calls[0].path, NOTES_COMMAND_PATH);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].init.body), { request: { action: 'create', id: 'a.md', text: 'x' } });
  });

  it('refuses to send an invalid command at all', async () => {
    const { calls, request } = stub(() => ({ body: {} }));
    await assert.rejects(new NotesApi(request).command({ action: 'save', id: 'a.md', text: 'x', expectedRevision: 'nope' }));
    assert.equal(calls.length, 0, 'an invalid command must never reach the server');
  });
});

describe('failures', () => {
  it('surfaces the server failure code and conflict revision', async () => {
    const { request } = stub(() => ({
      status: 409,
      body: { error: { code: 'conflict', message: 'changed', currentRevision: revision } },
    }));
    await assert.rejects(new NotesApi(request).read('a.md'), error => {
      assert.ok(error instanceof NotesApiError);
      assert.equal(error.code, 'conflict');
      assert.equal(error.currentRevision, revision);
      return true;
    });
  });

  it('maps a non-envelope failure without crashing', async () => {
    const { request } = stub(() => ({ status: 500, body: { unexpected: true } }));
    await assert.rejects(new NotesApi(request).tree(), error => error.code === 'storage_unavailable');
  });

  it('maps a non-JSON body without crashing', async () => {
    const request = async () => new Response('<html>nope</html>', { status: 200 });
    await assert.rejects(new NotesApi(request).tree(), error => error.code === 'storage_unavailable');
  });

  it('rejects a malformed success payload', async () => {
    const { request } = stub(() => ({ body: { vault: '/v' } }));
    await assert.rejects(new NotesApi(request).tree());
  });
});
