/** The retrieval half of the memory bridge: tokens, ranking, and the bounded injected block. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONTEXT_CHARS, MAX_CONTEXT_TOKENS, contextTokens, rankRelated, renderRelatedNotes,
} from '../src/context.ts';

/** One vault entry as the listing reports it. */
const entry = (id, title, mtimeMs = 1) => ({ id, title, dir: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '', size: 10, mtimeMs });

describe('context tokens', () => {
  it('keeps whole latin words and windows a Han run into two-character pairs', () => {
    assert.deepEqual(contextTokens('Review the pnpm workspace'), ['review', 'pnpm', 'workspace']);
    assert.deepEqual(contextTokens('只读探测'), ['只读', '读探', '探测']);
  });

  it('drops filler in both languages and stops widening the search', () => {
    // 继续, 帮我, 一下, please: filler only, so one real window survives.
    assert.deepEqual(contextTokens('继续 帮我 看一下 please'), ['看一']);
    const long = contextTokens('alpha bravo charlie delta echo foxtrot golf hotel india juliet');
    assert.equal(long.length, MAX_CONTEXT_TOKENS);
    assert.deepEqual(long.slice(0, 2), ['alpha', 'bravo']);
  });

  it('never crosses the language boundary inside one word', () => {
    // Each side of the boundary contributes only its own kind of token: no '跑p' or '试pytest'.
    assert.deepEqual(contextTokens('跑pytest测试'), ['测试', 'pytest']);
  });

  it('returns nothing usable for punctuation, numbers and single characters', () => {
    assert.deepEqual(contextTokens('... — !'), []);
    assert.deepEqual(contextTokens('ab'), []);
    assert.deepEqual(contextTokens(''), []);
  });
});

describe('ranking', () => {
  const vault = [
    entry('评估/Codex 自动审批与 ClawMaster 守卫.md', 'Codex 自动审批与 ClawMaster 守卫', 10),
    entry('设计/WatchDog 三段审查与笔记系统.md', 'WatchDog 三段审查与笔记系统', 20),
    entry('日记/2026-09-14.md', '2026-09-14', 30),
    entry('守卫草稿.md', '守卫草稿', 5),
  ];

  it('needs a title match and prefers the note that matches more of the request', () => {
    const ranked = rankRelated(vault, contextTokens('笔记系统里的审查'), 5);
    assert.deepEqual(ranked.map(note => note.id), ['设计/WatchDog 三段审查与笔记系统.md']);
    assert.ok(ranked[0].score >= 4);
  });

  it('never returns a path-only match, which would be a coincidence', () => {
    assert.deepEqual(rankRelated(vault, ['评估'], 5), []);
  });

  it('breaks a tie by the newer note and then by id, never by listing order', () => {
    const ranked = rankRelated([entry('a/守卫.md', '守卫', 1), entry('b/守卫.md', '守卫', 9)], ['守卫'], 5);
    assert.deepEqual(ranked.map(note => note.id), ['b/守卫.md', 'a/守卫.md']);
    const same = rankRelated([entry('z/守卫.md', '守卫', 3), entry('a/守卫.md', '守卫', 3)], ['守卫'], 5);
    assert.deepEqual(same.map(note => note.id), ['a/守卫.md', 'z/守卫.md']);
  });

  it('honours its limit and refuses to rank without tokens', () => {
    assert.equal(rankRelated(vault, ['守卫'], 1).length, 1);
    assert.deepEqual(rankRelated(vault, [], 3), []);
    assert.deepEqual(rankRelated(vault, ['守卫'], 0), []);
  });
});

describe('rendered block', () => {
  it('names the notes, says how to open one, and claims only a name match', () => {
    const text = renderRelatedNotes(rankRelated([
      entry('设计/WatchDog 三段审查与笔记系统.md', 'WatchDog 三段审查与笔记系统'),
    ], ['审查'], 3));
    assert.match(text, /matched by note name/);
    assert.match(text, /notes_query \(mode: read\)/);
    assert.match(text, /- 设计\/WatchDog 三段审查与笔记系统\.md/);
  });

  it('shows a frontmatter title beside an id that does not already carry it', () => {
    const text = renderRelatedNotes([{ id: '日记/2026-09-14.md', title: '九月十四', score: 2 }]);
    assert.match(text, /- 九月十四 \(日记\/2026-09-14\.md\)/);
  });

  it('stays inside its character budget and counts what it left out', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `目录/一个相当长的笔记名称用来占满预算-${index}.md`, title: '守卫与审查记录', score: 2,
    }));
    const text = renderRelatedNotes(many);
    assert.ok(text.length <= MAX_CONTEXT_CHARS + 40, `block stayed bounded: ${text.length}`);
    assert.match(text, /more matched but did not fit/);
  });

  it('says nothing at all when no note was named', () => {
    assert.equal(renderRelatedNotes([]), '');
    assert.equal(renderRelatedNotes([], 'search'), '');
  });
});
