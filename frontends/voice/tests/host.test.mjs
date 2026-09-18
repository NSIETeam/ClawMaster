/**
 * The Host as the profile loads it: real routes, real tools, a real timeline on disk.
 *
 * `apply()` is called with a stub of DSH's connection, tool and approval services, so this proves the
 * contract the profile depends on — route paths, method sets, request envelopes, tool names and
 * approval gates — instead of only the service underneath it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { apply } from '../src/host.ts';
import { encodeWav, toBase64 } from '../src/wav.ts';

/**
 * Point the component at a stub speech engine.
 *
 * This uses the supported override — `CLAWMASTER_VOICE_ENGINE` names a module exporting
 * `createEngine(options)` — rather than a test-only seam in the Host, so the Host under test is the
 * one production loads. The stub decides text and voice vector from the audio's sign, which is what
 * lets attribution be asserted without a model.
 * @param root - A directory the stub module is written into.
 * @returns The module path to put in the environment variable.
 */
async function installStubEngine(root) {
  const path = join(root, 'stub-engine.mjs');
  await writeFile(path, [
    'export async function createEngine() {',
    '  return {',
    "    description: 'stub engine',",
    '    sampleRate: 16000,',
    "    transcribe: async samples => ({ text: samples[0] > 0 ? '甲说话' : '乙说话' }),",
    '    embedding: async samples => {',
    '      const vector = new Float32Array(samples[0] > 0 ? [1, 0] : [0, 1]);',
    '      let sum = 0; for (const n of vector) sum += n * n;',
    '      const length = Math.sqrt(sum) || 1;',
    '      return vector.map(n => n / length);',
    '    },',
    '    dispose: () => undefined,',
    '  };',
    '}',
    '',
  ].join('\n'));
  return path;
}

/** A 16 kHz mono WAV of a constant level, which the stub engine reads as one speaker. */
function segment(positive) {
  const samples = new Float32Array(8_000);
  samples.fill(positive ? 0.5 : -0.5);
  return toBase64(encodeWav({ samples, sampleRate: 16_000 }));
}

/** A stand-in for DSH's services, recording what the plugin registered. */
function stubHost() {
  const routes = new Map();
  const tools = new Map();
  const provided = new Map();
  const approvals = [];
  const events = [];
  const host = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return async () => { routes.delete(route.path); };
        },
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    approval: {
      async request(request) {
        approvals.push(request);
        // DSH's approval service answers with `allowed-once`, a one-shot grant; anything else is a
        // refusal, which is what the tools check for.
        return 'allowed-once';
      },
    },
    effect: async (factory) => {
      const dispose = await factory();
      if (typeof dispose === 'function') events.push(dispose);
      return dispose;
    },
    provide(name, value) {
      provided.set(name, value);
    },
    get: name => provided.get(name),
  };
  return { host, routes, tools, provided, approvals, close: async () => { for (const dispose of events) await dispose(); } };
}

/** Boot the plugin over a temporary vault and data root. */
async function boot(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'voice-host-'));
  // The component loads its engine from `CLAWMASTER_VOICE_ENGINE` when that names a module, which is
  // the same override a user would use to plug in another engine; production sets no such variable.
  process.env.CLAWMASTER_VOICE_ENGINE = await installStubEngine(root);
  const stub = stubHost();
  // A stand-in for the notes plugin's published handle, so the write-up path can be exercised without
  // composing the notes component into this test.
  if (options.notes !== undefined) stub.provided.set('clawmasterNotes', options.notes);
  await apply(stub.host, {
    vaultRoot: join(root, 'vault'),
    dataRoot: join(root, 'data'),
    threads: 1,
    language: 'auto',
  });
  return { ...stub, root, vault: join(root, 'vault'), data: join(root, 'data') };
}

/** Close a booted component, then drop its temporary tree and its engine override. */
async function shutdown(app) {
  await app.close();
  delete process.env.CLAWMASTER_VOICE_ENGINE;
  await rm(app.root, { recursive: true, force: true });
}

/** Call one registered route with a JSON body the way the panel would. */
async function post(route, body) {
  return route.fetch(new Request(`http://localhost${route.path ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

test('the plugin registers its five routes on the authenticated carrier', async () => {
  const app = await boot();
  try {
    assert.deepEqual([...app.routes.keys()].sort(), [
      '/api/clawmaster/voice/audio',
      '/api/clawmaster/voice/models',
      '/api/clawmaster/voice/session',
      '/api/clawmaster/voice/speakers',
      '/api/clawmaster/voice/state',
    ]);
    for (const route of app.routes.values()) {
      assert.equal(route.requestBody, 'buffered');
      assert.ok(Array.isArray(route.methods) && route.methods.length > 0);
    }
  } finally {
    await shutdown(app);
  }
});

test('the plugin registers its two tools and publishes its access handle', async () => {
  const app = await boot();
  try {
    assert.deepEqual([...app.tools.keys()].sort(), ['voice_state', 'voice_transcribe', 'voice_writeup']);
    const access = app.provided.get('clawmaster.voice');
    assert.equal(typeof access.read, 'function');
    assert.equal(access.vaultRoot, app.vault);
    assert.equal(access.ready(), true);
  } finally {
    await shutdown(app);
  }
});

test('a full recording session travels through the routes', async () => {
  const app = await boot();
  try {
    const state = app.routes.get('/api/clawmaster/voice/state');
    const session = app.routes.get('/api/clawmaster/voice/session');
    const audio = app.routes.get('/api/clawmaster/voice/audio');

    const empty = await state.fetch(new Request('http://localhost/api/clawmaster/voice/state'));
    assert.equal(await empty.json(), null, 'nothing is recording before a start');

    const started = await (await post({
      path: '/api/clawmaster/voice/session',
      fetch: session.fetch,
    }, { request: { action: 'start', title: '产品评审', project: '项目中枢' } })).json();
    assert.equal(started.title, '产品评审');
    assert.equal(started.status, 'listening');
    assert.equal(started.engine.ready, true);

    const first = await (await post({
      path: '/api/clawmaster/voice/audio',
      fetch: audio.fetch,
    }, { request: { sessionId: started.sessionId, startMs: 0, endMs: 500, wav: segment(true) } })).json();
    assert.equal(first.utterance.text, '甲说话');
    assert.equal(first.newSpeaker, true);

    const live = await (await state.fetch(new Request('http://localhost/api/clawmaster/voice/state'))).json();
    assert.equal(live.utterances.length, 1);
    assert.equal(live.speakers.length, 1);
    assert.equal(live.sessionId, started.sessionId);

    const stopped = await (await post({
      path: '/api/clawmaster/voice/session',
      fetch: session.fetch,
    }, { request: { action: 'stop', sessionId: started.sessionId } })).json();
    assert.equal(stopped.status, 'stopped');

    // The finished session is readable by id, which is what the note writer needs.
    const readBack = await (await state.fetch(new Request(`http://localhost/api/clawmaster/voice/state?sessionId=${started.sessionId}`))).json();
    assert.equal(readBack.utterances[0].text, '甲说话');
    assert.equal(readBack.status, 'stopped');
  } finally {
    await shutdown(app);
  }
});

test('a rejected command answers with the typed failure and a 400', async () => {
  const app = await boot();
  try {
    const session = app.routes.get('/api/clawmaster/voice/session');
    const response = await post({ path: '/api/clawmaster/voice/session', fetch: session.fetch }, { request: { action: 'stop', sessionId: '00000000-0000-4000-8000-000000000000' } });
    assert.equal(response.status, 400);
    const failure = await response.json();
    assert.equal(failure.error.code, 'no_session');

    const notJson = await session.fetch(new Request('http://localhost/api/clawmaster/voice/session', { method: 'POST', body: 'plain' }));
    assert.equal(notJson.status, 400);
    assert.equal((await notJson.json()).error.code, 'invalid_request');
  } finally {
    await shutdown(app);
  }
});

test('renames, merges and voiceprints are reachable through the speakers route', async () => {
  const app = await boot();
  try {
    const session = app.routes.get('/api/clawmaster/voice/session');
    const audio = app.routes.get('/api/clawmaster/voice/audio');
    const speakers = app.routes.get('/api/clawmaster/voice/speakers');
    const started = await (await post({ path: '/api/clawmaster/voice/session', fetch: session.fetch }, { request: { action: 'start', title: '周会' } })).json();
    const first = await (await post({ path: '/api/clawmaster/voice/audio', fetch: audio.fetch }, { request: { sessionId: started.sessionId, startMs: 0, endMs: 500, wav: segment(true) } })).json();
    const second = await (await post({ path: '/api/clawmaster/voice/audio', fetch: audio.fetch }, { request: { sessionId: started.sessionId, startMs: 600, endMs: 1100, wav: segment(false) } })).json();

    const renamed = await (await post({ path: '/api/clawmaster/voice/speakers', fetch: speakers.fetch }, { request: { action: 'rename', sessionId: started.sessionId, speakerId: first.speaker.id, name: '李总' } })).json();
    assert.equal(renamed.name, '李总');

    const enrolled = await (await post({ path: '/api/clawmaster/voice/speakers', fetch: speakers.fetch }, { request: { action: 'enroll', name: '李总', wav: segment(true), sessionId: started.sessionId, speakerId: first.speaker.id } })).json();
    assert.equal(enrolled.vectors, 1);

    const merged = await (await post({ path: '/api/clawmaster/voice/speakers', fetch: speakers.fetch }, { request: { action: 'merge', sessionId: started.sessionId, from: second.speaker.id, into: first.speaker.id } })).json();
    assert.equal(merged.id, first.speaker.id);

    const listed = await (await speakers.fetch(new Request('http://localhost/api/clawmaster/voice/speakers'))).json();
    assert.deepEqual(listed.enrolled, ['李总']);
    assert.equal(listed.state.speakers.length, 1);
    assert.equal(listed.state.speakers[0].name, '李总');
  } finally {
    await shutdown(app);
  }
});

test('the timeline on disk is the record the write-up will be derived from', async () => {
  const app = await boot();
  try {
    const session = app.routes.get('/api/clawmaster/voice/session');
    const audio = app.routes.get('/api/clawmaster/voice/audio');
    const started = await (await post({ path: '/api/clawmaster/voice/session', fetch: session.fetch }, { request: { action: 'start', title: '周会' } })).json();
    await post({ path: '/api/clawmaster/voice/audio', fetch: audio.fetch }, { request: { sessionId: started.sessionId, startMs: 0, endMs: 500, wav: segment(true) } });
    const text = await readFile(join(app.vault, '.clawmaster', 'voice', `${started.sessionId}.jsonl`), 'utf8');
    const kinds = text.trim().split('\n').map(line => JSON.parse(line).kind);
    assert.deepEqual(kinds, ['session', 'speaker', 'utterance']);
  } finally {
    await shutdown(app);
  }
});

test('the voice_state tool reads live state and model readiness without approval', async () => {
  const app = await boot();
  try {
    const tool = app.tools.get('voice_state');
    // DSH's dispatcher applies `output.render` to whatever `execute` returns
    // (packages/core/tools/src/index.ts:1790), so the tool returns its payload and the declared
    // renderer turns it into text. Both halves are asserted here.
    const models = await tool.execute({ mode: 'models' }, { signal: undefined });
    assert.equal(models.engine, true);
    assert.deepEqual(models.installed, []);
    assert.equal(models.missing.length > 0, true);
    const rendered = tool.output.render({ mode: 'models' }, models);
    assert.equal(Array.isArray(rendered), true);
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /"engine":true/);
    assert.equal(app.approvals.length, 0, 'a read never asks for approval');

    const session = app.routes.get('/api/clawmaster/voice/session');
    await post({ path: '/api/clawmaster/voice/session', fetch: session.fetch }, { request: { action: 'start', title: '周会' } });
    const live = await tool.execute({ mode: 'live' }, { signal: undefined });
    assert.equal(live.title, '周会');
    assert.equal(live.status, 'listening');
    assert.equal(app.approvals.length, 0);

    // An unknown session is a typed failure, not an empty answer.
    await assert.rejects(tool.execute({ mode: 'session', sessionId: '00000000-0000-4000-8000-000000000000' }, { signal: undefined }), /No recording/);
    assert.match(tool.description, /never needs approval/);
  } finally {
    await shutdown(app);
  }
});

test('the transcribe tool needs a running session and names the model in its description', async () => {
  const app = await boot();
  try {
    const tool = app.tools.get('voice_transcribe');
    assert.match(tool.description, /one-shot DSH approval/);
    await assert.rejects(tool.execute({ wav: segment(true) }, { signal: undefined }), /No recording session is running/);
  } finally {
    await shutdown(app);
  }
});

test('unloading the plugin removes every route and tool', async () => {
  const app = await boot();
  try {
    assert.equal(app.routes.size, 5);
    assert.equal(app.tools.size, 3);
    await app.close();
    assert.equal(app.routes.size, 0);
    assert.equal(app.tools.size, 0);
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test('a relative vault root is refused at load time', async () => {
  const stub = stubHost();
  await assert.rejects(apply(stub.host, { vaultRoot: 'relative/vault' }), /absolute path/);
  await assert.rejects(apply(stub.host, { dataRoot: 'relative/data' }), /absolute path/);
});

/** A notes handle that records what a write-up would put in the vault. */
function stubNotes() {
  const written = [];
  const journals = [];
  const handle = {
    root: '/vault',
    /** The note text a read returns, so a test can simulate a person's edit between two run-throughs. */
    existing: undefined,
    written,
    journals,
    read: async id => {
      void id;
      if (handle.existing === undefined) throw new Error('not found');
      return { text: handle.existing };
    },
    writeNote: async (id, text) => {
      written.push({ id, text });
      return { id, revision: 'sha256-written', previousRevision: written.length > 1 ? 'sha256-previous' : null };
    },
    digest: async entry => {
      journals.push(entry);
      return { id: '日记/2026-09-14.md', revision: 'sha256-journal' };
    },
  };
  return handle;
}

test('a meeting is written up into the notes vault through the published handle', async () => {
  const notes = stubNotes();
  const app = await boot({ notes });
  try {
    const session = app.routes.get('/api/clawmaster/voice/session');
    const audio = app.routes.get('/api/clawmaster/voice/audio');
    const started = await (await post({ path: '/api/clawmaster/voice/session', fetch: session.fetch }, { request: { action: 'start', title: '产品评审' } })).json();
    await post({ path: '/api/clawmaster/voice/audio', fetch: audio.fetch }, { request: { sessionId: started.sessionId, startMs: 0, endMs: 500, wav: segment(true) } });
    await post({ path: '/api/clawmaster/voice/audio', fetch: audio.fetch }, { request: { sessionId: started.sessionId, startMs: 600, endMs: 1100, wav: segment(false) } });

    const tool = app.tools.get('voice_writeup');
    assert.equal(app.tools.has('voice_writeup'), true);
    const result = await tool.execute({
      sessionId: started.sessionId,
      summary: '定了排期。',
      decisions: ['九月十六上线'],
      nextSteps: ['出排期表'],
    }, { agent: { id: 'agent-1' }, callId: 'call-1', name: 'voice_writeup', signal: undefined });

    assert.equal(app.approvals.length, 1, 'a vault write asks for approval exactly once');
    assert.equal(result.id.startsWith('录音/'), true, result.id);
    assert.match(result.id, /\.md$/);
    assert.equal(notes.written.length, 1);
    assert.match(notes.written[0].text, /## 摘要\n\n定了排期。/);
    assert.match(notes.written[0].text, /\*\*说话人 1\*\*：甲说话/);
    assert.match(notes.written[0].text, /- 九月十六上线/);
    assert.equal(notes.journals.length, 1);
    assert.match(notes.journals[0].summary, /\[\[录音\//);
    assert.equal(result.journalId, '日记/2026-09-14.md');
  } finally {
    await shutdown(app);
  }
});

test('a write-up needs the notes component, a real recording and a session', async () => {
  const app = await boot();
  try {
    const tool = app.tools.get('voice_writeup');
    await assert.rejects(tool.execute({ sessionId: '11111111-2222-4333-8444-555555555555', summary: 'x' }, { agent: { id: 'a' }, signal: undefined }), /notes component is not loaded/);
  } finally {
    await shutdown(app);
  }

  const notes = stubNotes();
  const withNotes = await boot({ notes });
  try {
    const tool = withNotes.tools.get('voice_writeup');
    await assert.rejects(tool.execute({ sessionId: '11111111-2222-4333-8444-555555555555', summary: 'x' }, { agent: { id: 'a' }, signal: undefined }), /No recording/);
    await assert.rejects(tool.execute({ summary: 'x' }, { agent: { id: 'a' }, signal: undefined }), /sessionId/);
    assert.equal(withNotes.approvals.length, 0, 'a refused write-up never reaches the approval gate');
    assert.equal(notes.written.length, 0);
  } finally {
    await shutdown(withNotes);
  }
});

test('a write-up keeps a paragraph a person added under the marker', async () => {
  const notes = stubNotes();
  const app = await boot({ notes });
  try {
    const session = app.routes.get('/api/clawmaster/voice/session');
    const audio = app.routes.get('/api/clawmaster/voice/audio');
    const started = await (await post({ path: '/api/clawmaster/voice/session', fetch: session.fetch }, { request: { action: 'start', title: '周会' } })).json();
    await post({ path: '/api/clawmaster/voice/audio', fetch: audio.fetch }, { request: { sessionId: started.sessionId, startMs: 0, endMs: 500, wav: segment(true) } });
    const tool = app.tools.get('voice_writeup');
    await tool.execute({ sessionId: started.sessionId, summary: '第一版。' }, { agent: { id: 'a' }, signal: undefined });

    // A person annotates the note, then the writer runs again.
    notes.existing = `${notes.written[0].text}\n我加的备注。\n`;
    const second = await tool.execute({ sessionId: started.sessionId, summary: '第二版。' }, { agent: { id: 'a' }, signal: undefined });
    assert.equal(second.replaced, true);
    assert.equal(second.keptHumanEdit, true);
    assert.match(notes.written[1].text, /第二版。/);
    assert.match(notes.written[1].text, /我加的备注。/);
    assert.equal(app.approvals.length, 2, 'each vault write is approved on its own');
  } finally {
    await shutdown(app);
  }
});
