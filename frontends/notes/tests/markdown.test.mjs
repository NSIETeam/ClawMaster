/** Markdown block model: structure, grouping and inline runs. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inlineTokens, parseMarkdown } from '../src/markdown.ts';

describe('block parsing', () => {
  it('drops the frontmatter head and keeps the body', () => {
    const blocks = parseMarkdown('---\ntitle: x\n---\n# 标题\n');
    assert.deepEqual(blocks, [{ kind: 'heading', level: 1, text: '标题' }]);
  });

  it('reads heading levels and joins consecutive lines into one paragraph', () => {
    const blocks = parseMarkdown('# 一\n\n### 三\n第一行\n第二行\n');
    assert.deepEqual(blocks, [
      { kind: 'heading', level: 1, text: '一' },
      { kind: 'heading', level: 3, text: '三' },
      { kind: 'paragraph', text: '第一行\n第二行' },
    ]);
  });

  it('groups bullets and numbers into separate lists', () => {
    const blocks = parseMarkdown('- a\n- b\n\n1. x\n2. y\n');
    assert.deepEqual(blocks, [
      { kind: 'list', text: '', items: ['a', 'b'], ordered: false },
      { kind: 'list', text: '', items: ['x', 'y'], ordered: true },
    ]);
  });

  it('reads quotes, rules and a blank line between blocks', () => {
    const blocks = parseMarkdown('> 引用一\n> 引用二\n\n---\n');
    assert.deepEqual(blocks, [
      { kind: 'quote', text: '引用一\n引用二' },
      { kind: 'rule', text: '' },
    ]);
  });

  it('keeps fenced code verbatim, including sample markup', () => {
    const blocks = parseMarkdown('```ts\nconst a = 1\n[[不解析]]\n```\n');
    assert.deepEqual(blocks, [{ kind: 'code', text: 'const a = 1\n[[不解析]]', language: 'ts' }]);
  });

  it('treats an unterminated fence as code to the end', () => {
    const blocks = parseMarkdown('```\nleft open\n');
    assert.deepEqual(blocks, [{ kind: 'code', text: 'left open', language: '' }]);
  });
});

describe('inline runs', () => {
  it('splits text, strong, code and wiki links', () => {
    assert.deepEqual(inlineTokens('看 [[目标|别名]] 和 **粗** 与 `码`'), [
      { kind: 'text', text: '看 ' },
      { kind: 'wiki', text: '别名', target: '目标' },
      { kind: 'text', text: ' 和 ' },
      { kind: 'strong', text: '粗' },
      { kind: 'text', text: ' 与 ' },
      { kind: 'code', text: '码' },
    ]);
  });

  it('strips a heading anchor from a wiki target and defaults the label', () => {
    assert.deepEqual(inlineTokens('[[笔记#小节]]'), [{ kind: 'wiki', text: '笔记', target: '笔记' }]);
  });

  it('returns plain text when nothing matches', () => {
    assert.deepEqual(inlineTokens('普通文本'), [{ kind: 'text', text: '普通文本' }]);
    assert.deepEqual(inlineTokens(''), []);
  });
});
