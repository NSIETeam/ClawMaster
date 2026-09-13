/** Notes service: query bounds, every command receipt and daily-note behaviour. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/vault.ts';
import { DEFAULT_LIMITS, NotesService, commandSummary, dailyNote, localDate } from '../src/service.ts';

const rejects = code => error => error?.code === code;

async function withService(run, limits) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-service-'));
  try {
    return await run(new NotesService(await Vault.open(root), limits), root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('daily note template', () => {
  it('names the note by date and carries a diary head', () => {
    const { id, header } = dailyNote('2026-09-13');
    assert.equal(id, '日记/2026-09-13.md');
    assert.match(header, /^---\ntitle: 2026-09-13\n/);
    assert.match(header, /# 2026-09-13\n$/);
  });

  it('formats the local date as YYYY-MM-DD', () => {
    assert.equal(localDate(new Date(2026, 8, 13, 23, 30)), '2026-09-13');
    assert.equal(localDate(new Date(2026, 0, 2, 0, 0)), '2026-01-02');
  });
});

describe('query bounds', () => {
  it('fails loudly when the vault exceeds the tree budget', async () => {
    await withService(async service => {
      await service.execute({ action: 'create', id: 'a.md', text: 'a' });
      await service.execute({ action: 'create', id: 'b.md', text: 'b' });
      await assert.rejects(service.tree(), rejects('invalid_request'));
    }, { ...DEFAULT_LIMITS, maxTreeEntries: 1 });
  });

  it('fails loudly when a note exceeds the read budget', async () => {
    await withService(async service => {
      await service.execute({ action: 'create', id: 'big.md', text: 'x'.repeat(64) });
      await assert.rejects(service.read('big.md'), rejects('invalid_request'));
    }, { ...DEFAULT_LIMITS, maxReadBytes: 16 });
  });

  it('clamps search to the configured maximum', async () => {
    await withService(async service => {
      for (const id of ['a.md', 'b.md', 'c.md']) await service.execute({ action: 'create', id, text: '关键词' });
      const result = await service.search('关键词', 100);
      assert.equal(result.matches.length, 2);
    }, { ...DEFAULT_LIMITS, maxSearchResults: 2 });
  });

  it('rejects a non-positive search limit', async () => {
    await withService(async service => {
      await assert.rejects(service.search('x', 0), rejects('invalid_request'));
    });
  });
});

describe('commands', () => {
  it('reports a receipt with the revisions needed to audit each mutation', async () => withService(async service => {
    const created = await service.execute({ action: 'create', id: 'a.md', text: '一' });
    assert.equal(created.action, 'create');
    assert.equal(created.previousRevision, null);
    assert.match(created.revision, /^sha256-/);

    const appended = await service.execute({ action: 'append', id: 'a.md', text: '二' });
    assert.equal((await service.read('a.md')).text, '一\n二');

    const saved = await service.execute({ action: 'save', id: 'a.md', text: '三', expectedRevision: appended.revision });
    assert.equal(saved.previousRevision, appended.revision);

    const renamed = await service.execute({ action: 'rename', id: 'a.md', to: '目录/b.md' });
    assert.equal(renamed.id, '目录/b.md');
    assert.equal(renamed.previousRevision, saved.revision);

    const removed = await service.execute({ action: 'delete', id: '目录/b.md' });
    assert.equal(removed.revision, null);
    assert.equal(removed.previousRevision, renamed.revision);
  }));

  it('refuses a stale save instead of overwriting', async () => withService(async service => {
    await service.execute({ action: 'create', id: 'a.md', text: '一' });
    await assert.rejects(
      service.execute({ action: 'save', id: 'a.md', text: '二', expectedRevision: `sha256-${'0'.repeat(64)}` }),
      rejects('conflict'),
    );
    assert.equal((await service.read('a.md')).text, '一');
  }));

  it('validates the command envelope before touching the vault', async () => withService(async service => {
    await assert.rejects(service.execute({ action: 'delete', id: '../escape.md' }));
    await assert.rejects(service.execute({ action: 'nonsense' }));
    assert.deepEqual((await service.tree()).notes, []);
  }));
});

describe('daily workflow', () => {
  it('creates the daily note once and appends afterwards', async () => withService(async service => {
    const first = await service.execute({ action: 'daily', text: '上午：完成 vault 核心', date: '2026-09-13' });
    assert.equal(first.id, '日记/2026-09-13.md');
    assert.equal(first.previousRevision, null);
    const second = await service.execute({ action: 'daily', text: '下午：接线打包', date: '2026-09-13' });
    assert.equal(second.previousRevision, first.revision);
    const text = (await service.read('日记/2026-09-13.md')).text;
    assert.match(text, /# 2026-09-13/);
    assert.match(text, /上午：完成 vault 核心/);
    assert.match(text, /下午：接线打包/);
    assert.equal(text.match(/^# 2026-09-13$/gm).length, 1);
  }));
});

describe('daily opening', () => {
  it('opens the daily note without writing anything when the entry is empty', async () => withService(async service => {
    const opened = await service.execute({ action: 'daily', text: '', date: '2026-09-13' });
    assert.equal(opened.id, '日记/2026-09-13.md');
    const text = (await service.read(opened.id)).text;
    assert.equal(text.match(/^# 2026-09-13$/gm)?.length, 1);
    assert.deepEqual((await service.tree()).notes.map(note => note.id), ['日记/2026-09-13.md']);

    // A second open must not grow the note or change its revision.
    const again = await service.execute({ action: 'daily', text: '', date: '2026-09-13' });
    assert.equal(again.revision, opened.revision);
    assert.equal((await service.read(opened.id)).text, text);
  }));

  it('still appends a real entry after the note was opened', async () => withService(async service => {
    const opened = await service.execute({ action: 'daily', text: '', date: '2026-09-13' });
    const written = await service.execute({ action: 'daily', text: '下午：修完 A1', date: '2026-09-13' });
    assert.equal(written.previousRevision, opened.revision);
    assert.match((await service.read(opened.id)).text, /下午：修完 A1/);
  }));
});

describe('tags and metadata', () => {
  it('counts tags across notes, most used first', async () => withService(async service => {
    await service.execute({ action: 'create', id: 'a.md', text: '---\ntags: [工作, 项目]\n---\n#工作\n' });
    await service.execute({ action: 'create', id: 'b.md', text: '#工作\n' });
    assert.deepEqual(await service.tags(), [{ tag: '工作', count: 2 }, { tag: '项目', count: 1 }]);
  }));

  it('describes every command for an approval prompt', () => {
    const root = '/tmp/vault';
    const commands = [
      { action: 'create', id: 'a.md', text: 'x' },
      { action: 'save', id: 'a.md', text: 'x', expectedRevision: `sha256-${'0'.repeat(64)}` },
      { action: 'append', id: 'a.md', text: 'x' },
      { action: 'daily', text: 'x' },
      { action: 'rename', id: 'a.md', to: 'b.md' },
      { action: 'delete', id: 'a.md' },
    ];
    for (const command of commands) {
      const summary = commandSummary(command, root);
      assert.match(summary, /\/tmp\/vault/);
      assert.ok(summary.length > 20, `summary too short for ${command.action}`);
    }
    assert.match(commandSummary(commands[4], root), /b\.md/);
    assert.match(commandSummary(commands[5], root), /not moved to a trash folder/);
  });
});


describe('shared query budgets and concurrent commands', () => {
  it('applies the entry budget to tree, search, tags and backlinks', async () => withService(async service => {
    await service.execute({ action: 'create', id: 'a.md', text: '[[b]] #tag' });
    await service.execute({ action: 'create', id: 'b.md', text: 'second' });
    for (const operation of [() => service.tree(), () => service.search('second'), () => service.tags(), () => service.backlinks('b.md')]) {
      await assert.rejects(operation, rejects('invalid_request'));
    }
  }, { ...DEFAULT_LIMITS, maxTreeEntries: 1 }));

  it('applies the byte budget to every query that reads note bodies or titles', async () => withService(async service => {
    await service.execute({ action: 'create', id: 'large.md', text: 'x'.repeat(64) });
    for (const operation of [() => service.read('large.md'), () => service.tree(), () => service.search('x'), () => service.tags(), () => service.backlinks('large.md')]) {
      await assert.rejects(operation, rejects('invalid_request'));
    }
  }, { ...DEFAULT_LIMITS, maxReadBytes: 16 }));

  it('creates one daily header and retains every concurrent work entry with accurate receipts', async () => withService(async service => {
    const receipts = await Promise.all(['上午', '中午', '下午'].map(text => service.execute({ action: 'daily', text, date: '2026-09-13' })));
    assert.equal(receipts.filter(receipt => receipt.previousRevision === null).length, 1);
    const note = await service.read('日记/2026-09-13.md');
    assert.equal(note.text.match(/^# 2026-09-13$/gm).length, 1);
    for (const text of ['上午', '中午', '下午']) assert.equal(note.text.split('\n').filter(line => line === text).length, 1);
    const revisions = new Set(receipts.map(receipt => receipt.revision));
    for (const receipt of receipts) if (receipt.previousRevision !== null) assert.ok(revisions.has(receipt.previousRevision));
    assert.ok(revisions.has(note.revision));
  }));
});


describe('pending proposal diff budgets', () => {
  it('bounds the combined before and after UTF-8 bytes across proposals', async () => withService(async service => {
    for (const id of ['a.md', 'b.md']) {
      await service.vault.create(id, '文'.repeat(150));
      await service.propose(id, '稿'.repeat(30));
    }
    await assert.rejects(service.pendingProposals(), rejects('invalid_request'));
    assert.equal((await service.proposals.list()).length, 2);
    assert.equal((await service.read('a.md')).text, '文'.repeat(150));
  }, { ...DEFAULT_LIMITS, maxReadBytes: 1000 }));

  it('accepts combined diff inputs exactly at the byte budget', async () => withService(async service => {
    await service.vault.create('a.md', '文'.repeat(250));
    await service.propose('a.md', 'x'.repeat(250));
    assert.equal((await service.pendingProposals()).length, 1);
  }, { ...DEFAULT_LIMITS, maxReadBytes: 1000 }));

  it('reports an over-budget source instead of rendering it as a missing note', async () => withService(async service => {
    const original = await service.vault.create('a.md', 'small');
    await service.propose('a.md', 'draft');
    await service.vault.save('a.md', 'x'.repeat(1001), original);
    await assert.rejects(service.pendingProposals(), rejects('invalid_request'));
  }, { ...DEFAULT_LIMITS, maxReadBytes: 1000 }));
});
