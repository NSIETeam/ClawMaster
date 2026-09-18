/**
 * Capture rules: device frames in, one posted utterance out.
 *
 * The cases here are the ones that decide whether a meeting is transcribed at all: a device rate that
 * is not 16 kHz, a device that delivers chunk sizes that do not divide into frames, a network post
 * that fails, and a stop that must release the microphone. All of it runs without a microphone,
 * because the device is injected.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Recorder } from '../src/recorder.ts';
import { decodeWav } from '../src/wav.ts';
import { SAMPLE_RATE } from '../src/protocol.ts';

const FRAME_MS = 20;

/** A device whose frames the test pushes by hand, with a chosen sample rate and chunk size. */
function fakeDevice(sampleRate = SAMPLE_RATE) {
  let onFrame = () => {};
  const state = { stopped: 0, started: false, frameSize: 0 };
  const device = {
    sampleRate,
    start(frameSize, handler) {
      state.started = true;
      state.frameSize = frameSize;
      onFrame = handler;
    },
    stop() {
      state.stopped += 1;
      onFrame = () => {};
    },
  };
  return {
    state,
    device,
    /** Deliver `ms` of a constant level, in chunks of `chunk` samples, as a device would. */
    feed(ms, level, chunk = device.sampleRate * 0.1) {
      const total = Math.round((sampleRate * ms) / 1000);
      const buffer = new Float32Array(total);
      for (let index = 0; index < total; index += 1) buffer[index] = index % 2 === 0 ? level : -level;
      for (let offset = 0; offset < total; offset += chunk) {
        onFrame(buffer.slice(offset, Math.min(total, offset + chunk)));
      }
    },
  };
}

/** A sink that records what was posted, and can be made to fail a number of times. */
function fakeSink(failures = 0) {
  const posts = [];
  let remaining = failures;
  return {
    posts,
    postAudio: async input => {
      if (remaining > 0) {
        remaining -= 1;
        const error = new Error('network down');
        error.code = 'network';
        throw error;
      }
      posts.push(input);
      return {
        utterance: { id: `u${String(posts.length).padStart(6, '0')}`, sessionId: input.sessionId, startMs: input.startMs, endMs: input.endMs, speakerId: 'spk-00000001', text: '甲说话' },
        speaker: { id: 'spk-00000001', name: '说话人 1', named: false, voiceprints: 1, lastHeardAt: 0 },
        newSpeaker: posts.length === 1,
      };
    },
  };
}

/**
 * Wait for the recorder to finish whatever it posted.
 * Posts are deliberately fire-and-forget inside the capture callback, so a test has to wait for them
 * rather than assume the microtask queue has drained.
 * @param recorder - The recorder under test.
 * @param predicate - The condition to wait for.
 */
async function settle(recorder, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate(recorder.status())) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`Recording did not settle: ${JSON.stringify(recorder.status())}`);
}

/** A recorder over a device that captures at the given rate. */
async function recorderAt(sampleRate, options = {}) {
  const fake = fakeDevice(sampleRate);
  const sink = fakeSink(options.failures ?? 0);
  const statuses = [];
  const recorder = new Recorder({ supported: () => true, capture: async () => fake.device }, sink, {
    ...options,
    onStatus: status => statuses.push(status),
  });
  const rate = await recorder.start('00000000-0000-4000-8000-000000000001');
  return { recorder, fake, sink, statuses, rate };
}

test('a sentence is captured and posted as 16 kHz mono WAV', async () => {
  const { recorder, fake, sink } = await recorderAt(SAMPLE_RATE);
  fake.feed(200, 0.001);
  fake.feed(600, 0.3);
  fake.feed(800, 0.001);
  await settle(recorder, status => status.turns === 1);
  await recorder.stop();
  assert.equal(sink.posts.length, 1, 'exactly one utterance was posted');
  const post = sink.posts[0];
  assert.equal(post.sessionId, '00000000-0000-4000-8000-000000000001');
  assert.ok(post.endMs > post.startMs, `${post.startMs}..${post.endMs}`);
  const decoded = decodeWav(Uint8Array.from(Buffer.from(post.wav, 'base64')));
  assert.equal(decoded.sampleRate, SAMPLE_RATE, 'the post is resampled to what the engine expects');
  assert.equal(decoded.samples.length > 0, true);
  assert.equal(recorder.status().turns, 1);
  assert.equal(recorder.recording, false, 'the microphone was released');
  assert.equal(fake.state.stopped, 1);
});

test('a 48 kHz device is resampled before posting', async () => {
  const { recorder, fake, sink } = await recorderAt(48_000);
  fake.feed(200, 0.001);
  fake.feed(600, 0.3);
  fake.feed(800, 0.001);
  await settle(recorder, status => status.turns === 1);
  await recorder.stop();
  assert.equal(sink.posts.length, 1);
  const decoded = decodeWav(Uint8Array.from(Buffer.from(sink.posts[0].wav, 'base64')));
  assert.equal(decoded.sampleRate, SAMPLE_RATE);
  // 600 ms of speech at 16 kHz is 9600 samples; the pre-roll widens it but not by a multiple.
  assert.ok(decoded.samples.length >= 9_600, `got ${decoded.samples.length} samples`);
  assert.ok(decoded.samples.length < 20_000, `pre-roll is bounded, got ${decoded.samples.length}`);
});

test('a device whose chunks do not divide into frames stays aligned', async () => {
  const { recorder, fake, sink } = await recorderAt(SAMPLE_RATE);
  // 320 samples per frame; 701-sample chunks mean every callback leaves a remainder.
  fake.feed(200, 0.001, 701);
  fake.feed(600, 0.3, 701);
  fake.feed(900, 0.001, 701);
  await recorder.stop();
  assert.equal(sink.posts.length, 1, 'the sentence was found despite the odd chunk size');
  assert.ok(sink.posts[0].endMs >= 700, `endMs ${sink.posts[0].endMs}`);
});

test('a sentence still open at stop is posted', async () => {
  const { recorder, fake, sink } = await recorderAt(SAMPLE_RATE);
  fake.feed(100, 0.001);
  fake.feed(500, 0.3);
  await recorder.stop();
  assert.equal(sink.posts.length, 1, 'stop flushed the open sentence');
});

test('a failing post is retried once and then reported', async () => {
  const { recorder, fake, sink } = await recorderAt(SAMPLE_RATE, { failures: 1 });
  fake.feed(200, 0.001);
  fake.feed(600, 0.3);
  fake.feed(800, 0.001);
  await settle(recorder, status => status.turns === 1);
  assert.equal(sink.posts.length, 1, 'the retry succeeded');
  assert.equal(recorder.status().problem, undefined);
});

test('a post that keeps failing is reported and does not stop capture', async () => {
  const { recorder, fake, sink } = await recorderAt(SAMPLE_RATE, { failures: 2 });
  fake.feed(200, 0.001);
  fake.feed(600, 0.3);
  fake.feed(800, 0.001);
  await settle(recorder, status => status.problem !== undefined);
  assert.equal(sink.posts.length, 0, 'both attempts failed');
  assert.match(recorder.status().problem ?? '', /network down/);
  // The next sentence still goes out: a hole in the transcript is better than a dead recorder.
  fake.feed(200, 0.001);
  fake.feed(600, 0.3);
  await recorder.stop();
  assert.equal(sink.posts.length, 1, 'capture continued after the failure');
});

test('start refuses to open a second device', async () => {
  const { recorder } = await recorderAt(SAMPLE_RATE);
  await assert.rejects(recorder.start('00000000-0000-4000-8000-000000000002'), /already running/);
  await recorder.stop();
});

test('a claimed but unsupported environment reports it instead of failing at capture', () => {
  const recorder = new Recorder({ supported: () => false, capture: async () => { throw new Error('unreachable'); } }, fakeSink());
  assert.equal(recorder.supported, false);
  assert.equal(recorder.recording, false);
});

test('status reports elapsed time, level and turns', async () => {
  const { recorder, fake, statuses } = await recorderAt(SAMPLE_RATE);
  fake.feed(400, 0.3);
  await settle(recorder, status => status.level > 0.2);
  const status = recorder.status();
  assert.equal(status.recording, true);
  assert.ok(status.level > 0.2, `level ${status.level}`);
  assert.ok(status.elapsedMs >= 0, String(status.elapsedMs));
  assert.equal(statuses.length > 0, true, 'the panel was notified');
  assert.equal(statuses.at(-1).recording, true);
  await recorder.stop();
  assert.equal(statuses.at(-1).recording, false);
});

test('reset drops the open sentence without posting it', async () => {
  const { recorder, fake, sink } = await recorderAt(SAMPLE_RATE);
  fake.feed(100, 0.001);
  fake.feed(600, 0.3);
  recorder.reset();
  await recorder.stop();
  assert.equal(sink.posts.length, 0);
});
