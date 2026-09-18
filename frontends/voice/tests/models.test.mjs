/**
 * The real engine, the real models, real speech.
 *
 * Everything else in this suite proves the rules; this file proves the component works. It is the only
 * place where a downloaded model and a recorded voice are combined, and it is skipped — loudly, never
 * silently — on a machine where the models are not installed, so CI stays green without pretending.
 *
 * ffmpeg is not available here, so the samples are the ones the model itself ships: two readings by
 * different speakers, plus one speaker's recording cut in half. That is exactly what the two claims
 * under test need: halves of one recording must land on one label, and a different reading must not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../src/host.ts';
import { encodeWav, toBase64 } from '../src/wav.ts';
import { defaultModelDirectory } from '../src/engine.ts';

/** Where the models are, honouring the same environment override the component does. */
const MODELS = process.env.CLAWMASTER_VOICE_MODELS ?? defaultModelDirectory(homedir());
/** The model's own sample audio, kept in the build artifacts rather than in the repository. */
const WAVS = fileURLToPath(new URL('../../../.artifacts/voice-notes-pdf-20260914/test_wavs/', import.meta.url));

const READY = existsSync(join(MODELS, 'whisper-encoder.onnx'))
  && existsSync(join(MODELS, 'speaker-embedding.onnx'))
  && existsSync(join(WAVS, '0.wav'))
  && existsSync(join(WAVS, '1.wav'));

/** Skip with a reason on screen, because a silently skipped proof is worse than a failing one. */
const needsModels = READY ? false : `models not installed at ${MODELS} or samples missing at ${WAVS}`;

/** A stand-in for DSH's services, recording what the plugin registered. */
function stubHost() {
  const routes = new Map();
  const tools = new Map();
  const provided = new Map();
  const host = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    approval: { request: async () => ({ outcome: 'approved' }) },
    effect: async (factory) => factory(),
    provide: (name, value) => provided.set(name, value),
    get: name => provided.get(name),
  };
  return { host, routes, tools, provided };
}

/** Boot the real Host over a temporary vault, with the real engine. */
async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'voice-real-'));
  const stub = stubHost();
  await apply(stub.host, {
    vaultRoot: join(root, 'vault'),
    dataRoot: join(root, 'data'),
    threads: 2,
    language: 'auto',
    modelDirectory: MODELS,
  });
  return { ...stub, root, vault: join(root, 'vault') };
}

/** The base64 WAV of a slice of one sample recording, re-encoded at the rate the engine needs. */
function slice(recording, from, to) {
  const bytes = new Uint8Array(readFileSync(join(WAVS, recording)));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint16(22, true), 1, `${recording} must be mono`);
  assert.equal(view.getUint32(24, true), 16_000, `${recording} must be 16 kHz`);
  const samples = new Float32Array((bytes.byteLength - 44) / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(44 + index * 2, true) / 32768;
  const start = Math.round(16_000 * from);
  const end = Math.min(samples.length, Math.round(16_000 * to));
  return toBase64(encodeWav({ samples: samples.subarray(start, end), sampleRate: 16_000 }));
}

/** Post one segment through the real audio route. */
async function post(app, sessionId, wav, startMs, endMs, extra = {}) {
  const route = app.routes.get('/api/clawmaster/voice/audio');
  const response = await route.fetch(new Request('http://localhost/api/clawmaster/voice/audio', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: { sessionId, startMs, endMs, wav, ...extra } }),
  }));
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

/** Start a session through the real session route. */
async function start(app, title) {
  const route = app.routes.get('/api/clawmaster/voice/session');
  const response = await route.fetch(new Request('http://localhost/api/clawmaster/voice/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: { action: 'start', title } }),
  }));
  assert.equal(response.status, 200);
  return await response.json();
}

test('the real engine loads and the session reports it ready', { skip: needsModels }, async () => {
  const app = await boot();
  try {
    const models = app.tools.get('voice_state');
    const reported = await models.execute({ mode: 'models' }, { signal: undefined });
    assert.equal(reported.engine, true, JSON.stringify(reported));
    const started = await start(app, '模型自检');
    assert.equal(started.engine.ready, true);
    assert.match(started.engine.model, /Whisper/);
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test('two readings by different speakers separate, and halves of one reading do not', { skip: needsModels }, async () => {
  const app = await boot();
  try {
    const session = await start(app, '说话人分离实测');
    // 1.wav is one speaker for 16.7 s; two halves of it are the same voice 8 seconds apart.
    const firstHalf = await post(app, session.sessionId, slice('1.wav', 0.5, 8.5), 0, 8_000);
    const secondHalf = await post(app, session.sessionId, slice('1.wav', 8.5, 16.5), 8_500, 16_500);
    // 0.wav is a different speaker reading different text.
    const other = await post(app, session.sessionId, slice('0.wav', 0.5, 6.0), 17_000, 22_500);

    assert.ok(firstHalf.utterance.text.length > 20, JSON.stringify(firstHalf.utterance));
    assert.equal(secondHalf.speaker.id, firstHalf.speaker.id, 'halves of one reading are one speaker');
    assert.notEqual(other.speaker.id, firstHalf.speaker.id, 'a different reading is a different speaker');
    assert.equal(secondHalf.newSpeaker, false);
    assert.equal(other.newSpeaker, true);

    const state = app.tools.get('voice_state');
    const live = await state.execute({ mode: 'live' }, { signal: undefined });
    assert.equal(live.utterances.length, 3);
    assert.equal(live.speakers.length, 2);
    // The transcript is real text, not an empty placeholder.
    assert.match(live.utterances.map(turn => turn.text).join(' '), /[A-Za-z]{3,}/);
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test('an enrolled voice is recognized by name in a later session', { skip: needsModels }, async () => {
  const app = await boot();
  try {
    const speakers = app.routes.get('/api/clawmaster/voice/speakers');
    const command = async body => {
      const response = await speakers.fetch(new Request('http://localhost/api/clawmaster/voice/speakers', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: body }),
      }));
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      return payload;
    };

    // First meeting: recognize the voice, then enroll it under a name.
    const first = await start(app, '第一次会议');
    const heard = await post(app, first.sessionId, slice('1.wav', 0.5, 8.5), 0, 8_000);
    const enrolled = await command({ action: 'enroll', name: '李总', wav: slice('1.wav', 9.0, 16.0), sessionId: first.sessionId, speakerId: heard.speaker.id });
    assert.equal(enrolled.name, '李总');
    assert.equal(enrolled.vectors, 1);

    // Second meeting: the same voice arrives as a stranger and is named without being told.
    const second = await start(app, '第二次会议');
    const recognized = await post(app, second.sessionId, slice('1.wav', 2.0, 10.0), 0, 8_000);
    assert.equal(recognized.speaker.name, '李总');
    assert.equal(recognized.speaker.named, true);
    const stranger = await post(app, second.sessionId, slice('0.wav', 0.5, 6.0), 11_000, 16_500);
    assert.notEqual(stranger.speaker.name, '李总', 'a different voice is not named after the enrolled one');

    // Forgetting the voiceprint puts the next meeting back to anonymous.
    assert.equal((await command({ action: 'forget', name: '李总' })).forgotten, true);
    const third = await start(app, '第三次会议');
    const anonymous = await post(app, third.sessionId, slice('1.wav', 3.0, 11.0), 0, 8_000);
    assert.equal(anonymous.speaker.name, '说话人 1');
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test('a real recording leaves a timeline that replays to the same transcript', { skip: needsModels }, async () => {
  const app = await boot();
  try {
    const session = await start(app, '时间轴回放');
    const receipt = await post(app, session.sessionId, slice('0.wav', 0.5, 5.0), 0, 4_500);
    const state = app.tools.get('voice_state');
    const readBack = await state.execute({ mode: 'session', sessionId: session.sessionId }, { signal: undefined });
    assert.equal(readBack.utterances.length, 1);
    assert.equal(readBack.utterances[0].id, receipt.utterance.id);
    assert.equal(readBack.utterances[0].text, receipt.utterance.text);
    assert.equal(readBack.speakers.length, 1);
    assert.equal(readBack.status, 'listening');
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});
