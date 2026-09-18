/**
 * The service end to end, with a deterministic engine instead of a real model.
 *
 * The seam that makes this possible is `createEngine`: recognition is the only part that needs a
 * downloaded model, so everything the user can observe — attribution, the timeline, corrections —
 * is provable here without one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceError, VoiceService, decodeSegment } from '../src/service.ts';
import { encodeWav, toBase64 } from '../src/wav.ts';
import { normalize } from '../src/engine.ts';
import { replay } from '../src/store.ts';

/** A stub engine: it labels audio by its first sample and derives a vector from the same value. */
function stubEngine() {
  return async () => ({
    description: 'stub',
    sampleRate: 16_000,
    transcribe: async samples => ({ text: samples[0] > 0 ? '甲说话' : '乙说话' }),
    embedding: async samples => normalize(Float32Array.from(samples[0] > 0 ? [1, 0] : [0, 1])),
    dispose: () => undefined,
  });
}

/** A 16 kHz mono WAV whose level and sign encode which "speaker" it is. */
function segment(positive, milliseconds = 800) {
  const samples = new Float32Array(Math.round((16_000 * milliseconds) / 1000));
  samples.fill(positive ? 0.5 : -0.5);
  return toBase64(encodeWav({ samples, sampleRate: 16_000 }));
}

/** A service over a temporary vault, with a clock the test controls. */
async function harness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'voice-service-'));
  const vault = join(root, 'vault');
  const data = join(root, 'data');
  let now = 1_760_000_000_000;
  const service = new VoiceService({
    vaultRoot: vault,
    dataRoot: data,
    threads: 1,
    language: 'auto',
    fs: await import('node:fs/promises'),
    now: () => (now += 1000),
    createEngine: options.createEngine ?? stubEngine(),
    ...(options.modelDirectory === undefined ? {} : { modelDirectory: options.modelDirectory }),
  });
  return { service, vault, data, root, close: () => rm(root, { recursive: true, force: true }) };
}

test('a session records turns, separates speakers and survives a restart', async () => {
  const h = await harness();
  try {
    await h.service.open();
    const started = await h.service.start('产品评审', '项目中枢');
    assert.equal(started.title, '产品评审');
    assert.equal(started.speakers.length, 0);
    const first = await h.service.ingest({ sessionId: started.sessionId, startMs: 0, endMs: 800, wav: segment(true) });
    assert.equal(first.utterance.text, '甲说话');
    assert.equal(first.newSpeaker, true);
    assert.equal(first.speaker.name, '说话人 1');
    const second = await h.service.ingest({ sessionId: started.sessionId, startMs: 900, endMs: 1700, wav: segment(false) });
    assert.equal(second.newSpeaker, true);
    assert.equal(second.speaker.name, '说话人 2');
    const third = await h.service.ingest({ sessionId: started.sessionId, startMs: 1800, endMs: 2600, wav: segment(true) });
    assert.equal(third.newSpeaker, false);
    assert.equal(third.speaker.id, first.speaker.id);
    const state = h.service.state();
    assert.equal(state.utterances.length, 3);
    const ids = state.utterances.map(turn => turn.id);
    assert.deepEqual(ids, ['u000001', 'u000002', 'u000003']);
    assert.equal(new Set(ids).size, ids.length, 'turn ids are unique inside a session');
    assert.equal(state.speakers.length, 2);
    assert.equal(state.engine.ready, true);

    // A restart reads the same timeline back, labels included.
    const fresh = new VoiceService({
      vaultRoot: h.vault, dataRoot: h.data, threads: 1, language: 'auto',
      fs: await import('node:fs/promises'), now: () => 1_760_000_100_000, createEngine: stubEngine(),
    });
    const resumed = await fresh.resume(state.sessionId);
    assert.equal(resumed.utterances.length, 3);
    assert.deepEqual(resumed.speakers.map(speaker => speaker.name), ['说话人 1', '说话人 2']);
  } finally {
    await h.close();
  }
});

test('a rename reaches every turn already recorded', async () => {
  const h = await harness();
  try {
    await h.service.open();
    const started = await h.service.start('周会', undefined);
    const turn = await h.service.ingest({ sessionId: started.sessionId, startMs: 0, endMs: 500, wav: segment(true) });
    await h.service.rename(turn.speaker.id, '李总');
    const state = h.service.state();
    assert.equal(state.speakers[0].name, '李总');
    assert.equal(state.speakers[0].named, true);
    assert.equal(state.utterances[0].speakerId, turn.speaker.id);
    const text = await readFile(join(h.vault, '.clawmaster', 'voice', `${started.sessionId}.jsonl`), 'utf8');
    const derived = replay(text);
    assert.equal(derived.speakers[0].name, '李总');
  } finally {
    await h.close();
  }
});

test('a manual speaker hint overrides the automatic attribution', async () => {
  const h = await harness();
  try {
    await h.service.open();
    const started = await h.service.start('周会', undefined);
    const first = await h.service.ingest({ sessionId: started.sessionId, startMs: 0, endMs: 500, wav: segment(true) });
    const forced = await h.service.ingest({ sessionId: started.sessionId, startMs: 600, endMs: 1100, wav: segment(false), speakerHint: first.speaker.id });
    assert.equal(forced.utterance.speakerId, first.speaker.id);
    assert.equal(forced.newSpeaker, false);
  } finally {
    await h.close();
  }
});

test('ingest rejects a foreign session, reversed times and a wrong sample rate', async () => {
  const h = await harness();
  try {
    await h.service.open();
    const started = await h.service.start('周会', undefined);
    await assert.rejects(
      h.service.ingest({ sessionId: '00000000-0000-4000-8000-000000000000', startMs: 0, endMs: 100, wav: segment(true) }),
      error => error instanceof VoiceError && error.code === 'unknown_session',
    );
    await assert.rejects(
      h.service.ingest({ sessionId: started.sessionId, startMs: 900, endMs: 100, wav: segment(true) }),
      error => error instanceof VoiceError && error.code === 'invalid_request',
    );
    const wrongRate = toBase64(encodeWav({ samples: new Float32Array(8000), sampleRate: 8000 }));
    await assert.rejects(
      h.service.ingest({ sessionId: started.sessionId, startMs: 0, endMs: 500, wav: wrongRate }),
      error => error instanceof VoiceError && /16000 Hz/.test(error.message),
    );
  } finally {
    await h.close();
  }
});

test('commands outside a session are refused instead of silently doing nothing', async () => {
  const h = await harness();
  try {
    await h.service.open();
    await assert.rejects(h.service.stop(), error => error instanceof VoiceError && error.code === 'no_session');
    await assert.rejects(h.service.rename('spk-00000000', 'x'), error => error instanceof VoiceError && error.code === 'no_session');
  } finally {
    await h.close();
  }
});

test('a missing engine is reported, and transcription still records an empty turn', async () => {
  const h = await harness({ createEngine: async () => ({ description: 'unavailable: no model files', sampleRate: 16_000, transcribe: async () => ({ text: '' }), embedding: async () => undefined, dispose: () => undefined }) });
  try {
    await h.service.open();
    const started = await h.service.start('周会', undefined);
    const state = h.service.state();
    assert.equal(state.engine.ready, false);
    assert.match(state.engine.reason ?? '', /no model files/);
    const receipt = await h.service.ingest({ sessionId: started.sessionId, startMs: 0, endMs: 400, wav: segment(true) });
    assert.equal(receipt.utterance.text, '');
    assert.equal(h.service.models().engine, false);
  } finally {
    await h.close();
  }
});

test('enrolling a voice names the label and persists the voiceprint', async () => {
  const h = await harness();
  try {
    await h.service.open();
    const started = await h.service.start('周会', undefined);
    const turn = await h.service.ingest({ sessionId: started.sessionId, startMs: 0, endMs: 500, wav: segment(true) });
    const enrolled = await h.service.enroll('李总', segment(true), turn.speaker.id);
    assert.equal(enrolled.name, '李总');
    assert.equal(enrolled.vectors, 1);
    assert.equal(h.service.state().speakers[0].name, '李总');
    assert.deepEqual(h.service.enrolledNames(), ['李总']);
    // The next session recognizes the voice without being told.
    const next = await h.service.start('下一次周会', undefined);
    const recognized = await h.service.ingest({ sessionId: next.sessionId, startMs: 0, endMs: 500, wav: segment(true) });
    assert.equal(recognized.speaker.name, '李总');
    assert.equal(await h.service.forget('李总'), true);
    assert.deepEqual(h.service.enrolledNames(), []);
  } finally {
    await h.close();
  }
});

test('a session title defaults from the clock and the timeline is hidden from notes', async () => {
  const h = await harness();
  try {
    await h.service.open();
    const started = await h.service.start(undefined, undefined);
    assert.match(started.title, /^录音 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.ok(started.sessionId.length === 36);
    const text = await readFile(join(h.vault, '.clawmaster', 'voice', `${started.sessionId}.jsonl`), 'utf8');
    assert.match(text.split('\n')[0], /"kind":"session"/);
  } finally {
    await h.close();
  }
});

test('decodeSegment rejects an empty body', () => {
  assert.throws(() => decodeSegment(toBase64(encodeWav({ samples: new Float32Array(0), sampleRate: 16_000 }))), /no audio/);
});
