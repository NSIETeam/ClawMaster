/** Line diff, pending proposals and the composed work digest. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unifiedDiff } from '../src/diff.ts';
import { PROPOSAL_DIRECTORY } from '../src/proposals.ts';
import { Vault, VaultError } from '../src/vault.ts';
import { NotesService, composeDigest } from '../src/service.ts';

const rejects = code => error => error instanceof VaultError && error.code === code;

async function withService(run) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-proposal-'));
  try {
    const vault = await Vault.open(root);
    return await run(new NotesService(vault), root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('unified diff', () => {
  it('keeps unchanged lines as context and counts the rest', () => {
    const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
    assert.deepEqual(diff.lines, [
      { kind: 'context', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'context', text: 'c' },
    ]);
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert.equal(diff.truncated, false);
  });

  it('reads a changed block as removals before additions', () => {
    const diff = unifiedDiff('one\ntwo\n', 'first\nsecond\n');
    assert.deepEqual(diff.lines.map(line => line.kind), ['remove', 'remove', 'add', 'add']);
  });

  it('reports no changes for identical text', () => {
    const diff = unifiedDiff('# same\n', '# same\n');
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 0);
    assert.deepEqual(diff.lines, [{ kind: 'context', text: '# same' }]);
  });

  it('treats an empty note as a pure insertion', () => {
    const diff = unifiedDiff('', '# new\nbody\n');
    assert.equal(diff.added, 2);
    assert.equal(diff.removed, 0);
  });

  it('truncates a long diff with a marker instead of returning everything', () => {
    const before = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
    const after = Array.from({ length: 100 }, (_, index) => `changed ${index}`).join('\n');
    const diff = unifiedDiff(before, after, 40);
    assert.equal(diff.truncated, true);
    assert.equal(diff.lines.length, 41);
    assert.match(diff.lines[20].text, /elided/);
    assert.equal(diff.added, 100);
    assert.equal(diff.removed, 100);
  });

  it('degrades to a replacement for a very large input instead of a huge table', () => {
    const before = Array.from({ length: 2500 }, (_, index) => `a${index}`).join('\n');
    const diff = unifiedDiff(before, before + '\nlast\n', 40);
    assert.equal(diff.truncated, true);
    assert.equal(diff.removed, 2500);
    assert.equal(diff.added, 2501);
  });
});

describe('pending proposals', () => {
  it('stores a draft with the revision it was based on, without touching the note', async () => withService(async (service, root) => {
    await service.execute({ action: 'create', id: 'a.md', text: '# A\n' });
    const { proposal, diff } = await service.propose('a.md', '# A\nreviewed\n');
    assert.equal(proposal.id, 'a.md');
    assert.match(proposal.baseRevision, /^sha256-/);
    assert.equal(diff.added, 1);
    assert.equal((await service.read('a.md')).text, '# A\n', 'proposing must not change the note');
    assert.match(await readFile(join(root, PROPOSAL_DIRECTORY, `${proposal.proposalId}.json`), 'utf8'), /reviewed/);
    assert.deepEqual((await service.tree()).notes.map(note => note.id), ['a.md'], 'a proposal is not a note');
  }));

  it('records a null base revision for a note that does not exist yet', async () => withService(async service => {
    const { proposal, diff } = await service.propose('新的.md', '# 新的\n');
    assert.equal(proposal.baseRevision, null);
    assert.equal(diff.removed, 0);
  }));

  it('lists pending proposals with their diffs', async () => withService(async service => {
    await service.propose('a.md', 'x\n');
    await service.propose('b.md', 'y\n');
    const pending = await service.pendingProposals();
    assert.deepEqual(pending.map(entry => entry.proposal.id).sort(), ['a.md', 'b.md']);
    assert.equal(pending[0].diff.added, 1);
  }));
});

describe('applying proposals', () => {
  it('creates the note a proposal targets', async () => withService(async service => {
    const { proposal } = await service.propose('新笔记.md', '# 新笔记\n内容\n');
    const receipt = await service.applyProposal(proposal.proposalId);
    assert.equal(receipt.action, 'apply-proposal');
    assert.equal(receipt.id, '新笔记.md');
    assert.equal(receipt.previousRevision, null);
    assert.equal((await service.read('新笔记.md')).text, '# 新笔记\n内容\n');
    assert.deepEqual(await service.pendingProposals(), [], 'an applied proposal is removed');
  }));

  it('refuses to apply when the note moved since the proposal was drafted', async () => withService(async service => {
    const created = await service.execute({ action: 'create', id: 'a.md', text: 'one\n' });
    const { proposal } = await service.propose('a.md', 'two\n');
    await service.execute({ action: 'save', id: 'a.md', text: 'external edit\n', expectedRevision: created.revision });
    await assert.rejects(service.applyProposal(proposal.proposalId), rejects('conflict'));
    assert.equal((await service.read('a.md')).text, 'external edit\n');
  }));

  it('discards a proposal without touching the note', async () => withService(async service => {
    await service.execute({ action: 'create', id: 'a.md', text: '# A\n' });
    const { proposal } = await service.propose('a.md', '# A changed\n');
    assert.deepEqual(await service.discardProposal(proposal.proposalId), { proposalId: proposal.proposalId, id: 'a.md' });
    assert.deepEqual(await service.pendingProposals(), []);
    assert.equal((await service.read('a.md')).text, '# A\n');
  }));

  it('reports a missing proposal instead of failing silently', async () => withService(async service => {
    await assert.rejects(service.applyProposal('00000000-0000-4000-8000-000000000000'), rejects('not_found'));
    await assert.rejects(service.discardProposal('00000000-0000-4000-8000-000000000000'), rejects('not_found'));
    await assert.rejects(service.discardProposal('../../etc/passwd'));
  }));

  it('exposes both proposal commands through the command envelope', async () => withService(async service => {
    const { proposal } = await service.propose('a.md', 'x\n');
    const dropped = await service.execute({ action: 'discard-proposal', proposalId: proposal.proposalId });
    assert.equal(dropped.action, 'discard-proposal');
    assert.equal(dropped.id, 'a.md');
    assert.equal(dropped.revision, null);

    const second = await service.propose('a.md', '# A\n');
    const applied = await service.execute({ action: 'apply-proposal', proposalId: second.proposal.proposalId });
    assert.equal(applied.action, 'apply-proposal');
    assert.equal((await service.read('a.md')).text, '# A\n');
  }));
});

describe('work digest', () => {
  it('composes the sections it was given and omits the empty ones', () => {
    const markdown = composeDigest({
      summary: '修完 notes 模块的 A1',
      time: '16:40',
      decisions: ['用 NODE_ENV=test 固定测试环境', '  '],
      evidence: ['91/91 通过'],
    }, undefined, new Date());
    assert.match(markdown, /^### 16:40\n\n修完 notes 模块的 A1/);
    assert.match(markdown, /\*\*决定\*\*\n- 用 NODE_ENV=test 固定测试环境/);
    assert.match(markdown, /\*\*证据\*\*\n- 91\/91 通过/);
    assert.doesNotMatch(markdown, /下一步/);
  });

  it('links the project when a matching note exists', () => {
    assert.match(composeDigest({ summary: 'x', project: 'ClawMaster' }, '项目/ClawMaster'), /### .*· \[\[项目\/ClawMaster\]\]/);
    assert.match(composeDigest({ summary: 'x', project: '未建' }, undefined), /· 未建/);
  });

  it('appends one dated entry to the daily note and resolves the project link', async () => withService(async service => {
    await service.execute({ action: 'create', id: '项目/ClawMaster.md', text: '# ClawMaster\n' });
    const first = await service.digest({ summary: '完成 diff 与建议流程', project: 'ClawMaster', date: '2026-09-13', time: '16:40', nextSteps: ['补客户端面板'] });
    assert.equal(first.id, '日记/2026-09-13.md');
    assert.match(first.markdown, /\[\[项目\/ClawMaster\]\]/);
    const second = await service.digest({ summary: '第二条', date: '2026-09-13', time: '17:05' });
    assert.equal(second.previousRevision, first.revision);
    const text = (await service.read('日记/2026-09-13.md')).text;
    assert.equal(text.match(/^# 2026-09-13$/gm)?.length, 1);
    assert.match(text, /完成 diff 与建议流程/);
    assert.match(text, /第二条/);
  }));
});
