/** Result stage: turn facts, the composed review, and the archive path through the notes vault. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply, archiveTurn, NOTES_ACCESS_KEY } from '../src/index.ts';
import { DEFAULT_OPTIONS } from '../src/policy.ts';
import { composeResultReview } from '../src/review.ts';
import { collectTurn, isReviewable } from '../src/turn-facts.ts';

/** A turn that edited a file, ran its tests, and closed. */
const turnEvents = [
  { type: 'turn/start', data: { turn: 4 } },
  { type: 'user/message', data: { text: '把笔记面板的间距对齐宿主文件管理器\n第二行不该进摘要' } },
  { type: 'tool/call', data: { name: 'edit', arguments: { file_path: '/repo/frontends/notes/src/styles.css' } } },
  { type: 'tool/call', data: { name: 'bash', arguments: { command: 'pnpm run test:notes-client --reporter=dot' } } },
  { type: 'turn/end', data: { turn: 4 } },
];

describe('turn facts', () => {
  it('reduces a turn to files, commands, tools and verification', () => {
    const facts = collectTurn(turnEvents);
    assert.equal(facts.turn, 4);
    assert.match(facts.userPrompt, /间距/);
    assert.deepEqual(facts.tools.map(tool => tool.name), ['edit', 'bash']);
    assert.deepEqual(facts.files, ['/repo/frontends/notes/src/styles.css']);
    assert.deepEqual(facts.commands, ['pnpm run test:notes-client --reporter=dot']);
    assert.equal(facts.hasVerification, true);
    assert.equal(facts.failures, 0);
  });

  it('tolerates payloads it does not recognize instead of dropping the turn', () => {
    const facts = collectTurn([
      { type: 'tool/call' },
      { type: 'tool/call', data: { name: 'weird', arguments: 'not-a-record' } },
      { type: 'user/message', data: {} },
    ]);
    assert.deepEqual(facts.tools.map(tool => tool.name), ['unknown', 'weird']);
    assert.equal(facts.userPrompt, undefined);
  });

  it('keeps only the first line of a command', () => {
    const facts = collectTurn([{ type: 'tool/call', data: { name: 'bash', arguments: { command: 'echo a\nrm -rf /' } } }]);
    assert.deepEqual(facts.commands, ['echo a']);
  });

  it('only counts a turn that ran tools as reviewable', () => {
    assert.equal(isReviewable(collectTurn([{ type: 'user/message', data: { text: 'hi' } }])), false);
    assert.equal(isReviewable(collectTurn(turnEvents)), true);
  });
});

describe('composed review', () => {
  it('states what ran, on what, and what it could not establish', () => {
    const review = composeResultReview(collectTurn(turnEvents));
    assert.match(review.summary, /Turn 4 ran 2 tool calls/);
    assert.match(review.summary, /asked: 把笔记面板的间距对齐宿主文件管理器/);
    assert.ok(!review.summary.includes('\n'), 'the summary stays one line');
    assert.deepEqual(review.evidence, [
      'Commands: `pnpm run test:notes-client --reporter=dot`',
      'Files: `/repo/frontends/notes/src/styles.css`',
      'Tool calls: edit, bash',
    ]);
    assert.deepEqual(review.nextSteps, []);
  });

  it('flags an unverified turn rather than calling it done', () => {
    const review = composeResultReview(collectTurn([
      { type: 'tool/call', data: { name: 'edit', arguments: { file_path: '/repo/a.ts' } } },
      { type: 'tool/result', data: { isError: true } },
    ]));
    assert.deepEqual(review.nextSteps, [
      'No test, build or lint run appeared in this turn, so the result rests on inspection alone.',
    ]);
  });
});

describe('archive', () => {
  /** A host whose notes vault is a recording fake. */
  function host(access) {
    const listeners = new Map();
    const logs = [];
    return {
      listeners,
      logs,
      ctx: {
        on: (event, listener) => { listeners.set(event, listener); },
        get: name => name === NOTES_ACCESS_KEY ? access : undefined,
        logger: { info: message => logs.push(message), warn: message => logs.push(message) },
      },
    };
  }

  it('writes one digested entry per finished turn', async () => {
    const written = [];
    const fake = host({ digest: async entry => { written.push(entry); return { id: '日记/2026-09-14.md', revision: 'sha256-0'.repeat(1) }; } });
    apply(fake.ctx, { resultReview: 'archive' });
    const listener = fake.listeners.get('session/event');
    // One session identity for the whole turn: the harness hands the same Session to every event,
    // and the buffer is keyed by that identity.
    const session = { id: 'session-1' };
    for (const event of turnEvents) listener(session, event);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(written.length, 1);
    assert.match(written[0].summary, /Turn 4 ran 2 tool calls/);
    assert.deepEqual(written[0].evidence, [
      'Commands: `pnpm run test:notes-client --reporter=dot`',
      'Files: `/repo/frontends/notes/src/styles.css`',
      'Tool calls: edit, bash',
    ]);
    assert.equal(fake.logs.some(message => message.includes('result review archived to 日记/2026-09-14.md')), true);
  });

  it('buffers each session separately and drains at the turn boundary', async () => {
    const written = [];
    const fake = host({ digest: async entry => { written.push(entry); return { id: 'd.md', revision: 'r' }; } });
    apply(fake.ctx, { resultReview: 'archive' });
    const listener = fake.listeners.get('session/event');

    listener('a', { type: 'tool/call', data: { name: 'bash', arguments: { command: 'pnpm test' } } });
    listener('b', { type: 'tool/call', data: { name: 'edit', arguments: { file_path: '/x/y.ts' } } });
    listener('a', { type: 'turn/end', data: { turn: 1 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(written.length, 1);
    assert.match(written[0].summary, /Turn 1 ran 1 tool call\b/);

    listener('b', { type: 'turn/end', data: { turn: 2 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(written.length, 2);
    assert.match(written[1].summary, /Turn 2 ran 1 tool call\b/);
  });

  it('writes nothing when the review is off or the vault is absent', async () => {
    const quiet = host(undefined);
    apply(quiet.ctx, {});
    assert.equal(quiet.listeners.has('session/event'), false, 'off must not subscribe at all');

    const noVault = host(undefined);
    apply(noVault.ctx, { resultReview: 'archive' });
    const listener = noVault.listeners.get('session/event');
    for (const event of turnEvents) listener('s', event);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(noVault.logs.some(message => message.includes('notes vault is not mounted')));
  });

  it('never lets a failing vault break the session', async () => {
    const failing = host({ digest: async () => { throw new Error('vault is read-only'); } });
    apply(failing.ctx, { resultReview: 'archive' });
    const listener = failing.listeners.get('session/event');
    for (const event of turnEvents) listener('s', event);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(failing.logs.some(message => message.includes('result review failed: Error: vault is read-only')));
  });

  it('archives directly through the exported entry point', async () => {
    const written = [];
    const ctx = { get: () => ({ digest: async entry => { written.push(entry); return { id: 'd.md', revision: 'r' }; } }), logger: { info() {}, warn() {} } };
    await archiveTurn(ctx, collectTurn(turnEvents), { ...DEFAULT_OPTIONS, resultReview: 'archive', resultProject: 'ClawMaster' });
    assert.equal(written[0].project, 'ClawMaster');
    await archiveTurn(ctx, collectTurn([{ type: 'user/message', data: { text: 'hi' } }]), DEFAULT_OPTIONS);
    assert.equal(written.length, 1, 'a turn without tool calls is not archived');
  });
});
