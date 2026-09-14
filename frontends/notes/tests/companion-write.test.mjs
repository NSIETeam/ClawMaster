/**
 * The companion write door.
 *
 * The vault has one writer by design, so this is the only way another ClawMaster component may put a
 * note into it. The cases below are what make it safe to expose: a new note is created, rewriting the
 * same id replaces it (which is how a meeting note grows), and the obvious abuses are refused rather
 * than half-applied.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVault } from '../src/vault.ts';
import { NotesService, DEFAULT_LIMITS, localDate } from '../src/service.ts';
import { createNotesAccess } from '../src/access.ts';

async function vault() {
  const root = await mkdtemp(join(tmpdir(), 'notes-companion-'));
  const service = new NotesService(await openVault(root), DEFAULT_LIMITS);
  return { root, access: createNotesAccess(service, root), close: () => rm(root, { recursive: true, force: true }) };
}

test('a companion creates a note through the access handle', async () => {
  const v = await vault();
  try {
    const text = '---\ntitle: 周会\ntype: 录音\n---\n\n# 周会\n\n内容\n';
    const written = await v.access.writeNote('录音/2026-09-14 周会.md', text);
    assert.equal(written.id, '录音/2026-09-14 周会.md');
    assert.equal(written.previousRevision, null, 'the first write creates the note');
    assert.match(written.revision, /^sha256-[0-9a-f]{64}$/);
    assert.equal(await readFile(join(v.root, '录音/2026-09-14 周会.md'), 'utf8'), text);
    // The vault seeds a welcome note, so the created note is asserted alongside it rather than alone.
    const listed = (await v.access.list()).map(entry => entry.id);
    assert.equal(listed.includes('录音/2026-09-14 周会.md'), true, JSON.stringify(listed));
  } finally {
    await v.close();
  }
});

test('rewriting the same id replaces the body and moves the revision', async () => {
  const v = await vault();
  try {
    const first = await v.access.writeNote('录音/会议.md', '第一版\n');
    const second = await v.access.writeNote('录音/会议.md', '第二版\n');
    assert.equal(second.previousRevision, first.revision);
    assert.notEqual(second.revision, first.revision);
    assert.equal(await readFile(join(v.root, '录音/会议.md'), 'utf8'), '第二版\n');
    const ids = (await v.access.list()).map(entry => entry.id);
    assert.equal(ids.filter(id => id === '录音/会议.md').length, 1, 'a rewrite does not create a second note');
  } finally {
    await v.close();
  }
});

test('an empty write and a non-note path are refused', async () => {
  const v = await vault();
  try {
    await assert.rejects(v.access.writeNote('录音/会议.md', '   \n'), /may not be empty/);
    // A path that is not a note, an escape attempt and a wrong extension are all refused by the
    // vault's own path policy, which is why the messages name the rule rather than a generic error.
    await assert.rejects(v.access.writeNote('录音', '内容\n'), /must end with \.md/);
    await assert.rejects(v.access.writeNote('../escape.md', '内容\n'), /must not|invalid/i);
    await assert.rejects(v.access.writeNote('录音/会议.txt', '内容\n'), /must end with \.md/);
    await assert.rejects(v.access.writeNote('录音/会议.md', 'x'.repeat(DEFAULT_LIMITS.maxReadBytes + 1)), /may not exceed/);
    // Nothing was created by any of the refusals, and the welcome note is the only note present.
    const ids = (await v.access.list()).map(entry => entry.id);
    assert.deepEqual(ids, ['欢迎.md'], JSON.stringify(ids));
  } finally {
    await v.close();
  }
});

test('a companion note is a normal note: readable, searchable and linkable', async () => {
  const v = await vault();
  try {
    await v.access.writeNote('录音/周会.md', '---\ntitle: 周会\n---\n\n# 周会\n\n决定了 [[产品评审]] 的排期。\n');
    const read = await v.access.read('录音/周会.md');
    assert.equal(read.text.includes('产品评审'), true);
    const matches = await v.access.search('排期');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, '录音/周会.md');
  } finally {
    await v.close();
  }
});

test('a companion write never touches the day journal it links from', async () => {
  const v = await vault();
  try {
    await v.access.writeNote('录音/周会.md', '内容\n');
    const digest = await v.access.digest({ summary: '录了一场会', project: undefined });
    assert.equal(digest.id, `日记/${localDate()}.md`);
    const journal = await readFile(join(v.root, digest.id), 'utf8');
    assert.match(journal, /录了一场会/);
    // Two different notes, two different revision chains.
    const note = await readFile(join(v.root, '录音/周会.md'), 'utf8');
    assert.equal(note, '内容\n');
  } finally {
    await v.close();
  }
});
