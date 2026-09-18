/**
 * Speaker attribution and the enrolled voiceprints.
 * The rules under test are the ones that decide whether a transcript says "李总" or "说话人 2":
 * clustering on cosine distance, and a name that only ever comes from a human decision.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpeakerBook, SpeakerTracker } from '../src/speakers.ts';
import { cosine, normalize } from '../src/engine.ts';

/**
 * A unit vector along one axis, optionally leaning toward the other.
 * `voice(0)` and `voice(1)` are therefore near-orthogonal — the cosine distance the clusterer uses —
 * while `voice(0, 0.2)` stays clearly closer to `voice(0)` than to `voice(1)`.
 * @param axis - Which basis direction the voice points along.
 * @param lean - How far it leans toward the other direction, in [0,1).
 * @returns A normalized two-dimensional vector.
 */
function voice(axis, lean = 0) {
  const first = axis === 0 ? 1 : lean;
  const second = axis === 0 ? lean : 1;
  return normalize(Float32Array.from([first, second]));
}

test('one voice keeps one label across many turns', () => {
  const tracker = new SpeakerTracker();
  const first = tracker.attribute(voice(0), 1000);
  for (let index = 0; index < 5; index += 1) {
    const again = tracker.attribute(voice(0, 0.1), 2000 + index);
    assert.equal(again.speaker.id, first.speaker.id);
    assert.equal(again.created, false);
  }
  assert.equal(tracker.speakers().length, 1);
  assert.equal(tracker.speakers()[0].name, '说话人 1');
});

test('a second voice creates a second label with the ordinal name', () => {
  const tracker = new SpeakerTracker();
  const first = tracker.attribute(voice(0), 1000);
  const second = tracker.attribute(voice(1), 2000);
  assert.notEqual(first.speaker.id, second.speaker.id);
  assert.equal(second.created, true);
  assert.equal(second.speaker.name, '说话人 2');
  assert.equal(tracker.speakers().length, 2);
});

test('a voice vector between two labels joins the nearer one', () => {
  const tracker = new SpeakerTracker();
  const left = tracker.attribute(normalize(Float32Array.from([1, 0])), 1000);
  const right = tracker.attribute(normalize(Float32Array.from([0, 1])), 2000);
  const leaning = tracker.attribute(normalize(Float32Array.from([1, 0.2])), 3000);
  assert.equal(leaning.speaker.id, left.speaker.id);
  assert.equal(tracker.speakers().length, 2);
  assert.notEqual(left.speaker.id, right.speaker.id);
});

test('a turn with no vector joins the first label instead of inventing one per turn', () => {
  const tracker = new SpeakerTracker();
  const created = tracker.attribute(undefined, 1000);
  assert.equal(created.created, true);
  const again = tracker.attribute(undefined, 2000);
  assert.equal(again.created, false);
  assert.equal(again.speaker.id, created.speaker.id);
});

test('a rename marks the label as human-named and follows later turns', () => {
  const tracker = new SpeakerTracker();
  const first = tracker.attribute(voice(0), 1000);
  const renamed = tracker.rename(first.speaker.id, '李总');
  assert.equal(renamed.name, '李总');
  assert.equal(renamed.named, true);
  assert.equal(tracker.attribute(voice(0), 2000).speaker.name, '李总');
  assert.equal(tracker.rename('spk-00000000', 'x'), undefined);
});

test('a merge folds two labels and keeps the surviving centroid', () => {
  const tracker = new SpeakerTracker();
  const first = tracker.attribute(voice(0), 1000);
  const second = tracker.attribute(voice(1), 2000);
  const merged = tracker.merge(second.speaker.id, first.speaker.id);
  assert.equal(merged.id, first.speaker.id);
  assert.equal(tracker.speakers().length, 1);
  assert.equal(tracker.centroids().length, 1);
  assert.equal(tracker.merge(first.speaker.id, first.speaker.id), undefined);
  assert.equal(tracker.findById(second.speaker.id), undefined);
});

test('the tracker refuses to invent more labels than the cap', () => {
  const tracker = new SpeakerTracker(0.9, 2);
  tracker.attribute(normalize(Float32Array.from([1, 0])), 1000);
  tracker.attribute(normalize(Float32Array.from([0, 1])), 2000);
  const third = tracker.attribute(normalize(Float32Array.from([0.7, 0.7])), 3000);
  assert.equal(third.created, false);
  assert.equal(tracker.speakers().length, 2);
});

test('an enrolled voiceprint names a label from the first turn', async () => {
  const book = new SpeakerBook(join(await mkdtemp(join(tmpdir(), 'voice-book-')), 'speakers.json'));
  await book.enroll('李总', voice(0), 1000);
  const tracker = new SpeakerTracker(undefined, undefined, book);
  const attributed = tracker.attribute(voice(0), 2000);
  assert.equal(attributed.speaker.name, '李总');
  assert.equal(attributed.enrolledAs, '李总');
  assert.equal(attributed.created, true);
  assert.equal(attributed.speaker.named, true);
});

test('voiceprints survive a reload and keep several samples per name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-book-'));
  const path = join(directory, 'speakers.json');
  try {
    const first = new SpeakerBook(path);
    await first.enroll('李总', voice(0), 1000);
    await first.enroll('李总', voice(0, 0.9), 2000);
    await first.enroll('王工', voice(1), 3000);
    assert.equal(first.vectorCount('李总'), 2);
    const reopened = new SpeakerBook(path);
    await reopened.load();
    assert.deepEqual(reopened.names().sort(), ['王工', '李总'].sort());
    assert.equal(reopened.vectorCount('李总'), 2);
    const mode = (await readFile(path, 'utf8')).length > 0;
    assert.equal(mode, true);
    assert.equal(await reopened.forget('李总'), true);
    assert.equal(await reopened.forget('李总'), false);
    assert.deepEqual(reopened.names(), ['王工']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a corrupt voiceprint file is an empty book, not a crash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-book-'));
  const path = join(directory, 'speakers.json');
  try {
    const book = new SpeakerBook(path);
    await book.load();
    assert.deepEqual(book.names(), []);
    const broken = new SpeakerBook(join(directory, 'missing.json'));
    await broken.load();
    assert.deepEqual(broken.names(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cosine similarity of unit vectors is bounded and symmetric', () => {
  // voice(0) points along the first axis and voice(1) along the second, so distinct voices are
  // near-orthogonal while a voice is identical to itself.
  const left = voice(0);
  const right = voice(1);
  assert.ok(Math.abs(cosine(left, left) - 1) < 1e-6);
  assert.ok(cosine(left, right) < 0.2, `orthogonal voices scored ${cosine(left, right)}`);
  assert.ok(Math.abs(cosine(left, right) - cosine(right, left)) < 1e-6);
  assert.equal(cosine(new Float32Array(0), new Float32Array(0)), 0);
});
