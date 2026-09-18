/**
 * The timeline: replay, renames, merges and torn lines.
 * The invariant under test is the one the whole design rests on — the note is derived from the
 * timeline, so a correction must change every later derivation and must never need an in-place edit.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TranscriptStore, newUtteranceId, parseSequence, replay, summarize, writeUpName } from '../src/store.ts';

/** A store whose filesystem is a Map, so replay rules are tested without touching a disk. */
function memoryFs() {
  const files = new Map();
  return {
    files,
    mkdir: async () => undefined,
    appendFile: async (path, data) => { files.set(path, (files.get(path) ?? '') + data); },
    readFile: async path => {
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(path);
    },
    writeFile: async (path, data) => { files.set(path, data); },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
  };
}

const speaker = (id, name, voiceprints = 1) => ({ id, name, named: /^说话人/.test(name) === false, voiceprints, lastHeardAt: 0 });
const utterance = (sequence, speakerId, text, startMs = sequence * 1000) => ({
  id: newUtteranceId(sequence), sessionId: 's', startMs, endMs: startMs + 900, speakerId, text,
});

test('a fresh timeline replays to a header with no turns', async () => {
  const fs = memoryFs();
  const store = new TranscriptStore(fs, '/vault', 'sess-1');
  const index = await store.open('周会', '项目中枢', 1000);
  assert.equal(index.title, '周会');
  assert.equal(index.project, '项目中枢');
  assert.equal(index.status, 'listening');
  const replayed = await new TranscriptStore(fs, '/vault', 'sess-1').load();
  assert.deepEqual(replayed, index);
});

test('turns, speakers and status survive a restart', async () => {
  const fs = memoryFs();
  const store = new TranscriptStore(fs, '/vault', 'sess-1');
  await store.open('周会', undefined, 1000);
  await store.recordSpeaker(speaker('spk-00000001', '说话人 1'), [0.1, 0.2], 1100);
  await store.recordUtterance(utterance(1, 'spk-00000001', '大家好'), 1200);
  await store.recordStatus('stopped', 1300);
  const replayed = await new TranscriptStore(fs, '/vault', 'sess-1').load();
  assert.equal(replayed.speakers.length, 1);
  assert.equal(replayed.utterances[0].text, '大家好');
  assert.equal(replayed.utterances[0].id, 'u000001');
  assert.equal(replayed.lastSequence, 1);
  assert.equal(replayed.status, 'stopped');
  assert.deepEqual(replayed.centroids, [[0.1, 0.2]]);
});

test('a rename follows every turn already recorded under the old label', async () => {
  const fs = memoryFs();
  const store = new TranscriptStore(fs, '/vault', 'sess-1');
  await store.open('周会', undefined, 1000);
  await store.recordSpeaker(speaker('spk-00000001', '说话人 1'), undefined, 1100);
  await store.recordUtterance(utterance(1, 'spk-00000001', '大家好'), 1200);
  await store.recordRename('spk-00000001', '李总', 1300);
  const replayed = replay(fs.files.get(store.path));
  assert.equal(replayed.speakers[0].name, '李总');
  assert.equal(replayed.speakers[0].named, true);
  assert.equal(replayed.utterances[0].speakerId, 'spk-00000001', 'the turn keeps its identity, the label carries the name');
});

test('a merge moves every turn and drops the absorbed label', async () => {
  const fs = memoryFs();
  const store = new TranscriptStore(fs, '/vault', 'sess-1');
  await store.open('周会', undefined, 1000);
  await store.recordSpeaker(speaker('spk-00000001', '说话人 1', 2), [1, 0], 1100);
  await store.recordSpeaker(speaker('spk-00000002', '说话人 2', 3), [0, 1], 1200);
  await store.recordUtterance(utterance(1, 'spk-00000001', '甲'), 1300);
  await store.recordUtterance(utterance(2, 'spk-00000002', '乙'), 1400);
  assert.equal(await store.recordMerge('spk-00000002', 'spk-00000001', 1500), true);
  const replayed = replay(fs.files.get(store.path));
  assert.equal(replayed.speakers.length, 1);
  assert.equal(replayed.utterances.every(turn => turn.speakerId === 'spk-00000001'), true);
  assert.equal(replayed.speakers[0].voiceprints, 5);
  assert.equal(replayed.centroids.length, 1);
});

test('a merge into a label that does not exist is refused rather than half applied', async () => {
  const fs = memoryFs();
  const store = new TranscriptStore(fs, '/vault', 'sess-1');
  await store.open('周会', undefined, 1000);
  await store.recordSpeaker(speaker('spk-00000001', '说话人 1'), undefined, 1100);
  assert.equal(await store.recordMerge('spk-00000001', 'spk-deadbeef', 1200), false);
  assert.equal(replay(fs.files.get(store.path)).speakers.length, 1);
});

test('a torn last line costs one turn and keeps the rest', async () => {
  const fs = memoryFs();
  const store = new TranscriptStore(fs, '/vault', 'sess-1');
  await store.open('周会', undefined, 1000);
  await store.recordSpeaker(speaker('spk-00000001', '说话人 1'), undefined, 1100);
  await store.recordUtterance(utterance(1, 'spk-00000001', '第一句'), 1200);
  fs.files.set(store.path, `${fs.files.get(store.path)}{"kind":"utterance","at":1300,"utter`);
  const replayed = replay(fs.files.get(store.path));
  assert.equal(replayed.utterances.length, 1);
  assert.equal(replayed.utterances[0].text, '第一句');
});

test('a timeline with no header has no index', () => {
  assert.equal(replay('{"kind":"utterance","at":1}\n'), undefined);
  assert.equal(replay(''), undefined);
});

test('append order is preserved and flush waits for the last write', async () => {
  const fs = memoryFs();
  const store = new TranscriptStore(fs, '/vault', 'sess-1');
  await store.open('周会', undefined, 1000);
  await store.recordSpeaker(speaker('spk-00000001', '说话人 1'), undefined, 1100);
  const writes = [store.recordUtterance(utterance(1, 'spk-00000001', '一'), 1200), store.recordUtterance(utterance(2, 'spk-00000001', '二'), 1300)];
  await Promise.all(writes);
  await store.flush();
  const lines = fs.files.get(store.path).trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(lines, ['session', 'speaker', 'utterance', 'utterance']);
});

test('the summary counts turns, speakers and minutes', async () => {
  const fs = memoryFs();
  const store = new TranscriptStore(fs, '/vault', 'sess-1');
  await store.open('周会', undefined, 1000);
  await store.recordSpeaker(speaker('spk-00000001', '说话人 1'), undefined, 1100);
  await store.recordUtterance(utterance(1, 'spk-00000001', '一', 0), 1200);
  await store.recordUtterance(utterance(2, 'spk-00000001', '二', 90_000), 1300);
  const summary = summarize(replay(fs.files.get(store.path)));
  assert.equal(summary.turns, 2);
  assert.equal(summary.speakers, 1);
  assert.equal(summary.minutes, 1.5);
});

test('a title with path separators turns into one flat file name', async () => {
  const fs = memoryFs();
  const store = new TranscriptStore(fs, '/vault', 'sess-1');
  const index = await store.open('周会/预算:评审?', undefined, 1_760_000_000_000);
  const name = writeUpName(index);
  const title = name.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /, '');
  // A separator would silently create a folder or escape the note directory, so this is asserted
  // directly instead of by re-running the implementation's own character class.
  assert.equal(/[/\\]/.test(name), false, name);
  assert.equal(name.split('/').length, 1, name);
  assert.equal(title, '周会 预算 评审', name);
  assert.match(name, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /, name);
  assert.ok(name.endsWith('.md'), name);
});

test('a title that is nothing but separators still produces a usable name', async () => {
  const fs = memoryFs();
  const store = new TranscriptStore(fs, '/vault', 'sess-1');
  const index = await store.open('///', undefined, 1_760_000_000_000);
  const name = writeUpName(index);
  assert.equal(name.split('/').length, 1, name);
  assert.ok(name.endsWith('录音.md'), name);
});

test('sequence numbers round-trip and unknown ids are zero', () => {
  assert.equal(parseSequence('u000042'), 42);
  assert.equal(parseSequence('nonsense'), 0);
  assert.equal(parseSequence(newUtteranceId(7)), 7);
});
