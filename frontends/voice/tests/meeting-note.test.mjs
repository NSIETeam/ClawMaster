/**
 * The meeting note and the bridge that writes it.
 *
 * The note is a projection of the timeline, so these tests are about projection rules: the transcript
 * says who said what, a rename in the timeline reaches the note without editing it, a paragraph a person
 * added under the marker survives a rewrite, and nothing a writer composes can leave the recording
 * folder.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BODY_MARKER, composeMeetingNote, describeDuration, mergeWithExisting, notePathFor } from '../src/meeting-note.ts';
import { previewNoteId, timelineNameOf, writeUp } from '../src/notes-bridge.ts';

/** A timeline index as the store would replay it. */
function session(overrides = {}) {
  return {
    sessionId: '11111111-2222-4333-8444-555555555555',
    title: '产品评审',
    project: '项目中枢',
    startedAt: new Date('2026-09-14T10:05:00').getTime(),
    updatedAt: new Date('2026-09-14T10:35:00').getTime(),
    status: 'stopped',
    speakers: [
      { id: 'spk-00000001', name: '李总', named: true, voiceprints: 4, lastHeardAt: 0 },
      { id: 'spk-00000002', name: '说话人 2', named: false, voiceprints: 2, lastHeardAt: 0 },
    ],
    centroids: [],
    utterances: [
      { id: 'u000001', sessionId: 's', startMs: 0, endMs: 3_000, speakerId: 'spk-00000001', text: '  大家好， 今天评审排期。 ' },
      { id: 'u000002', sessionId: 's', startMs: 4_000, endMs: 7_500, speakerId: 'spk-00000002', text: '我这边资源够。' },
      { id: 'u000003', sessionId: 's', startMs: 8_000, endMs: 9_000, speakerId: 'spk-00000001', text: '' },
    ],
    lastSequence: 3,
    ...overrides,
  };
}

test('the note carries the vault frontmatter keys and a dated file name', () => {
  const note = composeMeetingNote({ session: session(), summary: '定了排期。', now: new Date('2026-09-14T11:00:00').getTime() });
  assert.equal(note.id, '录音/2026-09-14 产品评审.md');
  assert.match(note.text, /^---\ntitle: 产品评审\n/);
  // The folder tag and the explicit tag are the same tag, and the set is de-duplicated.
  assert.match(note.text, /\ntags: \[录音, 项目中枢\]\n/);
  assert.match(note.text, /\ncreated: 2026-09-14 10:05\n/);
  assert.match(note.text, /\nupdated: 2026-09-14 11:00\n/);
  assert.match(note.text, /\ntype: 录音\n---\n/);
});

test('the transcript names the speaker and the timecode of every turn', () => {
  const note = composeMeetingNote({ session: session(), summary: '定了排期。' });
  assert.match(note.text, /## 逐句记录/);
  // Whitespace inside a turn is collapsed, so an engine that pads a transcript cannot shape the note.
  assert.match(note.text, /- `00:00` \*\*李总\*\*：大家好， 今天评审排期。/);
  assert.match(note.text, /- `00:04` \*\*说话人 2\*\*：我这边资源够。/);
  // An empty recognition is shown as such rather than as a silent blank bullet.
  assert.match(note.text, /- `00:08` \*\*李总\*\*：（未识别到内容）/);
  // Unnamed labels are called out, with the way to fix them.
  assert.match(note.text, /仍有自动编号的说话人：说话人 2/);
});

test('the header states the duration, the speakers and the project link', () => {
  const note = composeMeetingNote({ session: session(), summary: '定了排期。' });
  assert.match(note.text, /- 时间：2026-09-14 10:05（9 秒，3 句）/);
  assert.match(note.text, /- 说话人：李总、说话人 2/);
  assert.match(note.text, /- 项目：\[\[项目中枢\]\]/);
});

test('a summary, decisions and next steps become their own sections', () => {
  const note = composeMeetingNote({
    session: session(),
    summary: '  定了排期。 ',
    decisions: ['九月十六上线', '   '],
    nextSteps: ['李总出排期表'],
  });
  assert.match(note.text, /## 摘要\n\n定了排期。/);
  assert.match(note.text, /## 决定\n\n- 九月十六上线\n/);
  assert.match(note.text, /## 下一步\n\n- 李总出排期表\n/);
  // An empty list section is omitted instead of leaving an empty heading.
  const bare = composeMeetingNote({ session: session(), summary: '无。' });
  assert.equal(bare.text.includes('## 决定'), false);
  assert.equal(bare.text.includes('## 下一步'), false);
});

test('a rename in the timeline reaches the composed note without touching a note', () => {
  const before = composeMeetingNote({ session: session(), summary: '定了排期。' });
  const renamed = session({
    speakers: [
      { id: 'spk-00000001', name: '李总', named: true, voiceprints: 4, lastHeardAt: 0 },
      { id: 'spk-00000002', name: '王工', named: true, voiceprints: 2, lastHeardAt: 0 },
    ],
  });
  const after = composeMeetingNote({ session: renamed, summary: '定了排期。' });
  assert.match(before.text, /说话人 2/);
  assert.match(after.text, /\*\*王工\*\*/);
  assert.equal(after.text.includes('说话人 2'), false);
  assert.equal(after.text.includes('仍有自动编号的说话人'), false);
  assert.equal(after.id, before.id, 'the same meeting keeps its file name');
});

test('a title with a separator stays inside the recording folder', () => {
  const note = composeMeetingNote({ session: session({ title: '预算/评审: 第二轮' }), summary: '无。' });
  assert.equal(note.id.startsWith('录音/'), true, note.id);
  assert.equal(note.id.slice('录音/'.length).includes('/'), false, note.id);
  assert.equal(note.id.includes('?'), false, note.id);
  const nothing = composeMeetingNote({ session: session({ title: '///' }), summary: '无。' });
  assert.equal(nothing.id, '录音/2026-09-14 录音.md');
});

test('the note always ends with the marker that protects a human edit', () => {
  const note = composeMeetingNote({ session: session(), summary: '无。' });
  assert.equal(note.text.trimEnd().endsWith(BODY_MARKER), true);
  assert.equal(note.text.split(BODY_MARKER).length, 2, 'the marker appears once');
});

test('a paragraph a person wrote under the marker survives a rewrite', () => {
  const composed = composeMeetingNote({ session: session(), summary: '定了排期。' }).text;
  const edited = `${composed}\n我的补充：下次带上预算表。\n`;
  const merged = mergeWithExisting(composed, edited);
  assert.equal(merged.includes('我的补充：下次带上预算表。'), true);
  assert.equal(merged.split(BODY_MARKER).length, 2, 'still exactly one marker');
  // Merging repeatedly does not accumulate blank lines or duplicate the note.
  const twice = mergeWithExisting(composed, merged);
  assert.equal(twice, merged);
  // A note with nothing under the marker is simply replaced.
  assert.equal(mergeWithExisting(composed, composed), composed);
  assert.equal(mergeWithExisting(composed, undefined), composed);
  assert.equal(mergeWithExisting(composed, 'a note with no marker at all'), composed);
});

test('a write-up writes the meeting note and links it from the day journal', async () => {
  const written = [];
  const digests = [];
  const notes = {
    root: '/vault',
    read: async () => { throw new Error('not found'); },
    writeNote: async (id, text) => { written.push({ id, text }); return { id, revision: 'sha256-a', previousRevision: null }; },
    digest: async entry => { digests.push(entry); return { id: '日记/2026-09-14.md', revision: 'sha256-b' }; },
  };
  const result = await writeUp(notes, { session: session(), summary: '定了排期。', decisions: ['九月十六上线'], nextSteps: ['出排期表'] });
  assert.equal(written.length, 1);
  assert.equal(result.id, '录音/2026-09-14 产品评审.md');
  assert.equal(result.replaced, false);
  assert.equal(result.keptHumanEdit, false);
  assert.equal(result.journalId, '日记/2026-09-14.md');
  // The journal line links to the note, which is what makes it a backlink.
  assert.match(digests[0].summary, /定了排期。/);
  assert.match(digests[0].summary, /\[\[录音\/2026-09-14 产品评审\]\]/);
  assert.equal(digests[0].project, '项目中枢');
  assert.deepEqual(digests[0].decisions, ['九月十六上线']);
  assert.deepEqual(digests[0].nextSteps, ['出排期表']);
  assert.match(digests[0].evidence[0], /\.clawmaster\/voice\//);
});

test('writing up twice replaces the note and reports the human edit it kept', async () => {
  const first = composeMeetingNote({ session: session(), summary: '定了排期。' }).text;
  const existing = `${first}\n我的补充。\n`;
  const written = [];
  const notes = {
    root: '/vault',
    read: async () => ({ text: existing }),
    writeNote: async (id, text) => { written.push({ id, text }); return { id, revision: 'sha256-c', previousRevision: 'sha256-a' }; },
    digest: async () => ({ id: '日记/2026-09-14.md', revision: 'sha256-d' }),
  };
  const result = await writeUp(notes, { session: session(), summary: '改了摘要。' });
  assert.equal(result.replaced, true);
  assert.equal(result.keptHumanEdit, true);
  assert.match(written[0].text, /改了摘要。/);
  assert.match(written[0].text, /我的补充。/);
});

test('the note preview and timeline name are the ones the writer will use', () => {
  const index = session();
  assert.equal(previewNoteId(index), '录音/2026-09-14 产品评审.md');
  assert.equal(previewNoteId(index, '会议'), '会议/2026-09-14 产品评审.md');
  assert.equal(timelineNameOf(index), `.clawmaster/voice/${index.sessionId}.jsonl`);
  assert.equal(notePathFor(index).endsWith('.md'), true);
});

test('a duration is stated in a unit a reader can use', () => {
  assert.equal(describeDuration(0), '0 秒');
  assert.equal(describeDuration(9_000), '9 秒');
  assert.equal(describeDuration(59_400), '59.4 秒');
  assert.equal(describeDuration(60_000), '1 分钟');
  assert.equal(describeDuration(750_000), '12.5 分钟');
});
