/**
 * Endpoint detection rules.
 *
 * These decide where a sentence starts and ends, which is the difference between a transcript that
 * reads like speech and one that reads like a waterfall. The cases below are the ones a real room
 * produces: leading silence, a pause in the middle of a thought, a hissing air conditioner, a door
 * slam, and a speaker who never pauses.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Endpointer, FRAME_MS, MAX_UTTERANCE_MS, feed, rmsOf } from '../src/endpointer.ts';

const RATE = 16_000;
const FRAME = (RATE * FRAME_MS) / 1000;

/** A frame of the given level, alternating sign so it has no DC offset. */
function frame(level, index = 0) {
  const samples = new Float32Array(FRAME);
  samples.fill(index % 2 === 0 ? level : -level);
  return samples;
}

/** Feed a run of frames without pushing the level across the onset threshold. */
function silence(endpointer, count, level = 0.001) {
  const done = [];
  for (let index = 0; index < count; index += 1) {
    const utterance = endpointer.push(frame(level, index));
    if (utterance !== undefined) done.push(utterance);
  }
  return done;
}

/** Feed `count` frames of speech. */
function speech(endpointer, count, level = 0.2) {
  const done = [];
  for (let index = 0; index < count; index += 1) {
    const utterance = endpointer.push(frame(level, index));
    if (utterance !== undefined) done.push(utterance);
  }
  return done;
}

test('a quiet room produces no utterance', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  assert.deepEqual(silence(endpointer, 200), []);
  assert.equal(endpointer.flush(), undefined);
  assert.equal(endpointer.status().speaking, false);
});

test('one sentence surrounded by silence yields one utterance', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  silence(endpointer, 25);
  assert.deepEqual(speech(endpointer, 50), [], 'the sentence is still open');
  assert.equal(endpointer.status().speaking, true);
  const done = silence(endpointer, 40);
  assert.equal(done.length, 1);
  const utterance = done[0];
  // 50 speech frames = 1000 ms; the pre-roll may widen the samples but not the speech window.
  assert.ok(Math.abs(utterance.endMs - utterance.startMs - 1000) < FRAME_MS * 2, `${utterance.startMs}..${utterance.endMs}`);
  assert.ok(utterance.level > 0.15, String(utterance.level));
  assert.equal(endpointer.status().speaking, false);
});

test('a short pause inside a sentence does not split it', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  silence(endpointer, 20);
  speech(endpointer, 30);
  const between = silence(endpointer, 10, 0.001);
  assert.deepEqual(between, [], '400 ms of silence is not a sentence break');
  const done = speech(endpointer, 30);
  assert.deepEqual(done, []);
  const final = silence(endpointer, 40).concat(endpointer.flush() ?? []);
  assert.equal(final.length, 1, 'the whole thought is one utterance');
});

test('a long pause does split it into two', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  silence(endpointer, 20);
  speech(endpointer, 40);
  const first = silence(endpointer, 40);
  assert.equal(first.length, 1);
  speech(endpointer, 40);
  const second = silence(endpointer, 40);
  assert.equal(second.length, 1);
  assert.ok(second[0].startMs > first[0].endMs, 'the second turn starts later');
});

test('a single loud frame is a click, not a sentence', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  silence(endpointer, 20);
  // One frame well above the threshold, then silence.
  endpointer.push(frame(0.9));
  const done = silence(endpointer, 40);
  assert.deepEqual(done, [], 'one frame never opens an utterance');
});

test('a hissing room does not hold a sentence open forever', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  // A steady noise floor that is loud enough to be audible but well below speech.
  silence(endpointer, 100, 0.02);
  speech(endpointer, 40, 0.25);
  // The room keeps hissing after the speaker stops; the floor adapts and the silence run is
  // measured in frames above that floor, so the sentence still closes.
  const done = silence(endpointer, 60, 0.02);
  assert.equal(done.length, 1, 'the sentence closed despite the room tone');
  assert.ok(done[0].startMs < done[0].endMs);
});

test('a speaker who never pauses is cut at the maximum length', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  // Real speech is never a constant level: even an unbroken sentence swings between loud syllables
  // and quiet ones, and the floor estimate is calibrated on exactly those quiet moments.
  const total = Math.ceil(MAX_UTTERANCE_MS / FRAME_MS) + 5;
  const done = [];
  for (let index = 0; index < total; index += 1) {
    const level = index % 4 === 3 ? 0.01 : 0.3;
    const utterance = endpointer.push(frame(level, index));
    if (utterance !== undefined) done.push(utterance);
  }
  assert.equal(done.length >= 1, true, 'the utterance was cut instead of growing without bound');
  assert.ok(done[0].endMs - done[0].startMs <= MAX_UTTERANCE_MS + FRAME_MS, `${done[0].startMs}..${done[0].endMs}`);
  assert.ok(done[0].samples.length > 0);
});

test('flush returns the open sentence, and nothing when there is none', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  silence(endpointer, 10);
  assert.equal(endpointer.flush(), undefined);
  speech(endpointer, 40);
  const final = endpointer.flush();
  assert.notEqual(final, undefined);
  assert.ok(final.endMs > final.startMs);
  assert.equal(endpointer.flush(), undefined, 'flushing twice does not duplicate the sentence');
});

test('reset drops the open sentence without emitting it', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  speech(endpointer, 40);
  endpointer.reset();
  assert.equal(endpointer.status().speaking, false);
  assert.equal(endpointer.flush(), undefined);
});

test('the samples handed to the decoder include the pre-roll', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  silence(endpointer, 30);
  speech(endpointer, 40);
  const done = silence(endpointer, 40);
  const utterance = done[0];
  const speechMs = utterance.endMs - utterance.startMs;
  const samplesMs = (utterance.samples.length / RATE) * 1000;
  assert.ok(samplesMs >= speechMs, 'the buffer covers at least the speech');
  assert.ok(samplesMs <= speechMs + 600, `pre-roll is bounded, got ${samplesMs} ms for ${speechMs} ms of speech`);
});

test('sensitivity lets quieter speech through', () => {
  const strict = new Endpointer({ sampleRate: RATE, sensitivity: 0.5 });
  const loose = new Endpointer({ sampleRate: RATE, sensitivity: 2 });
  silence(strict, 40, 0.01);
  silence(loose, 40, 0.01);
  const quiet = 0.02;
  const strictDone = speech(strict, 40, quiet).concat(silence(strict, 40, 0.01));
  const looseDone = speech(loose, 40, quiet).concat(silence(loose, 40, 0.01));
  assert.equal(looseDone.length, 1, 'the sensitive setting hears it');
  assert.equal(strictDone.length, 0, 'the stricter setting does not');
});

test('a frame of the wrong size is refused instead of silently mis-framed', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  assert.throws(() => endpointer.push(new Float32Array(FRAME - 1)), /must hold/);
  assert.equal(endpointer.frameSize, FRAME);
});

test('feed frames an arbitrary buffer and reports completed utterances', () => {
  const endpointer = new Endpointer({ sampleRate: RATE });
  const oneSecond = new Float32Array(RATE);
  oneSecond.fill(0.001);
  assert.deepEqual(feed(endpointer, oneSecond), []);
  const loud = new Float32Array(RATE);
  loud.fill(0.3);
  feed(endpointer, loud);
  const tail = new Float32Array(RATE);
  const done = feed(endpointer, tail);
  assert.equal(done.length, 1);
  // A partial frame at the end is carried over, not decoded, so nothing is misaligned.
  const odd = new Float32Array(FRAME + 3);
  odd.fill(0.001);
  assert.deepEqual(feed(endpointer, odd), []);
});

test('rmsOf is zero for silence and one for full scale', () => {
  assert.equal(rmsOf(new Float32Array(0)), 0);
  assert.equal(rmsOf(new Float32Array(10)), 0);
  assert.ok(Math.abs(rmsOf(new Float32Array(10).fill(1)) - 1) < 1e-6);
});
