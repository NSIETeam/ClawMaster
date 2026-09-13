/** Browser transport regressions cover stale and uncertain saves without replacing document logic. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { OfficeDocument, documentRevision, officePath } from '../src/services.ts';
import { win32 } from 'node:path';
import { OFFICE_PROTOCOL, OFFICE_PROTOCOL_VERSION } from '../src/protocol.ts';

const bytes = value => new TextEncoder().encode(value).buffer;
const digest = value => webcrypto.subtle.digest('SHA-256', value);
const changed = bytes('new document bytes');
test('file uploads retain absolute Windows drive roots and UNC share directories', () => {
  for (const path of ['C:/document.docx', 'C:\\document.docx', 'C:/Users/用户/document.docx', '\\\\server\\share\\document.docx', '//server/share/document.docx']) {
    const { dir, fileName } = officePath(path);
    assert.equal(win32.isAbsolute(dir), true, path);
    assert.equal(win32.resolve(dir, fileName), win32.resolve(path));
  }
  assert.equal(officePath('C:/document.docx').dir, 'C:/');
  assert.equal(officePath('C:\\document.docx').dir, 'C:\\');
  assert.deepEqual(officePath('/document.docx'), { dir: '/', fileName: 'document.docx' });
});
const nextState = (document, predicate) => new Promise(resolve => {
  if (predicate(document.getSnapshot())) { resolve(); return; }
  const unsubscribe = document.subscribe(() => { if (predicate(document.getSnapshot())) { unsubscribe(); resolve(); } });
});
async function fixture(t, upload) {
  const sent = [];
  const source = { postMessage: message => sent.push(message) };
  const requests = [];
  const document = new OfficeDocument({ sessionId: 'test', cwd: '/test' }, '/test/example.docx', 'zh-CN', {
    origin: 'http://localhost', channel: 'synthetic-channel', frame: () => source, digest,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return init?.method === 'POST' ? await upload(url, init) : new Response(bytes('original document bytes'));
    },
  });
  t.after(() => document.dispose());
  const receive = (data, extra = {}) => document.receive({ source, origin: 'http://localhost', data: { protocol: OFFICE_PROTOCOL, version: OFFICE_PROTOCOL_VERSION, channel: 'synthetic-channel', ...data }, ...extra });
  await document.start();
  receive({ type: 'ready' });
  receive({ type: 'opened' });
  assert.equal(document.getSnapshot().status, 'ready');
  return { document, receive, sent, requests };
}

test('a confirmed save advances the content revision and acknowledges exactly once', async t => {
  const revision = await documentRevision(changed, digest);
  const state = await fixture(t, async () => Response.json({ ok: true, value: { revision } }));
  state.receive({ type: 'save', requestId: 'one', bytes: changed });
  await nextState(state.document, state => state.status === 'saved');
  assert.equal(state.requests[1].init.headers['If-Match'], `"${await documentRevision(bytes('original document bytes'), digest)}"`);
  state.receive({ type: 'save', requestId: 'one', bytes: changed });
  assert.equal(state.requests.length, 2);
  state.receive({ type: 'save', requestId: 'two', bytes: changed });
  await nextState(state.document, state => state.status === 'saved');
  assert.equal(state.requests[2].init.headers['If-Match'], `"${revision}"`);
  assert.equal(state.document.getSnapshot().dirty, false);
  assert.equal(state.sent.filter(message => message.type === 'save-result' && message.ok).length, 2);
});
for (const [name, upload, expected] of [
  ['disk conflict', async () => new Response(null, { status: 412 }), 'conflict'],
  ['network uncertainty', async () => { throw new Error('offline'); }, 'save-error'],
  ['unconfirmed server revision', async () => Response.json({ ok: true, value: { revision: 'wrong' } }), 'save-error'],
]) test(`${name} retains a recoverable draft and never acknowledges success`, async t => {
  const state = await fixture(t, upload);
  state.receive({ type: 'save', requestId: 'save', bytes: changed });
  await nextState(state.document, state => state.status === expected);
  state.receive({ type: 'dirty', value: false });
  assert.equal(state.document.getSnapshot().dirty, true);
  assert.equal(state.document.getSnapshot().recovery, changed);
  assert.equal(state.sent.at(-1).ok, false);
});
test('another frame, origin, channel or malformed body cannot write the file', async t => {
  const state = await fixture(t, () => { throw new Error('unexpected upload'); });
  for (const extra of [{ source: {} }, { origin: 'http://foreign.invalid' }, { data: { channel: 'foreign' } }]) {
    state.receive({ type: 'save', requestId: 'bad', bytes: changed }, extra);
  }
  state.receive({ type: 'save', requestId: 'bad', bytes: 'not bytes' });
  assert.equal(state.requests.length, 1);
  state.document.dispose();
  state.receive({ type: 'save', requestId: 'after-dispose', bytes: changed });
  assert.equal(state.requests.length, 1);
});
