/** Docx block -> Markdown rendering, including the lossy cases. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blocksToMarkdown, inlineToMarkdown } from '../src/markdown.ts';

const textRun = (content, style) => ({ text_run: { content, ...(style ? { text_element_style: style } : {}) } });

function page(blocks) {
  return [{ block_id: 'page', block_type: 1, children: blocks.map(block => block.block_id), page: {} }, ...blocks];
}

describe('docx blocks to markdown', () => {
  it('returns an empty string for no blocks', () => {
    assert.equal(blocksToMarkdown([]), '');
    assert.equal(blocksToMarkdown(undefined), '');
  });

  it('renders a title, a paragraph and headings', () => {
    const markdown = blocksToMarkdown(page([
      { block_id: 'h1', block_type: 3, parent_id: 'page', heading1: { elements: [textRun('Title')] } },
      { block_id: 'p', block_type: 2, parent_id: 'page', text: { elements: [textRun('Body text')] } },
      { block_id: 'h3', block_type: 5, parent_id: 'page', heading3: { elements: [textRun('Deep')] } },
    ]), { title: 'Doc' });

    assert.match(markdown, /^# Doc\n/);
    assert.match(markdown, /^# Title$/m);
    assert.match(markdown, /^Body text$/m);
    assert.match(markdown, /^### Deep$/m);
  });

  it('renders bullets, nested bullets and ordered numbering', () => {
    const markdown = blocksToMarkdown(page([
      { block_id: 'b1', block_type: 12, parent_id: 'page', children: ['b2'], bullet: { elements: [textRun('outer')] } },
      { block_id: 'b2', block_type: 12, parent_id: 'b1', bullet: { elements: [textRun('inner')] } },
      { block_id: 'o1', block_type: 13, parent_id: 'page', ordered: { elements: [textRun('first')] } },
      { block_id: 'o2', block_type: 13, parent_id: 'page', ordered: { elements: [textRun('second')] } },
    ]));

    assert.match(markdown, /^- outer$/m);
    assert.match(markdown, /^ {2}- inner$/m);
    assert.match(markdown, /^1\. first$/m);
    assert.match(markdown, /^2\. second$/m);
  });

  it('restarts ordered numbering after an intervening block', () => {
    const markdown = blocksToMarkdown(page([
      { block_id: 'o1', block_type: 13, parent_id: 'page', ordered: { elements: [textRun('a')] } },
      { block_id: 'p', block_type: 2, parent_id: 'page', text: { elements: [textRun('break')] } },
      { block_id: 'o2', block_type: 13, parent_id: 'page', ordered: { elements: [textRun('b')] } },
    ]));

    assert.match(markdown, /^1\. a$/m);
    assert.match(markdown, /^1\. b$/m);
  });

  it('renders todo state and a fenced code block', () => {
    const markdown = blocksToMarkdown(page([
      { block_id: 't', block_type: 17, parent_id: 'page', todo: { elements: [textRun('done item')], style: { done: true } } },
      { block_id: 't2', block_type: 17, parent_id: 'page', todo: { elements: [textRun('open item')], style: { done: false } } },
      { block_id: 'c', block_type: 14, parent_id: 'page', code: { elements: [textRun('const a = 1;')], style: {} } },
    ]));

    assert.match(markdown, /^- \[x\] done item$/m);
    assert.match(markdown, /^- \[ \] open item$/m);
    assert.match(markdown, /```\nconst a = 1;\n```/);
  });

  it('renders inline styles without collapsing the text', () => {
    assert.equal(
      inlineToMarkdown([
        textRun('bold', { bold: true }),
        textRun(' and '),
        textRun('code', { inline_code: true }),
        textRun(' and '),
        textRun('struck', { strikethrough: true }),
        textRun(' and '),
        textRun('link', { link: { url: 'https://example.com' } }),
      ]),
      '**bold** and `code` and ~~struck~~ and [link](https://example.com)',
    );
  });

  it('marks an unsupported block type instead of dropping it silently', () => {
    const markdown = blocksToMarkdown(page([
      { block_id: 'x', block_type: 30, parent_id: 'page', sheet: { token: 'abc' } },
    ]));

    assert.match(markdown, /<!-- unsupported block_type: 30 -->/);
  });

  it('renders a table using the declared column size', () => {
    const markdown = blocksToMarkdown(page([
      {
        block_id: 'tbl',
        block_type: 31,
        parent_id: 'page',
        children: ['c1', 'c2', 'c3', 'c4'],
        table: { property: { row_size: 2, column_size: 2 } },
      },
      { block_id: 'c1', block_type: 32, parent_id: 'tbl', children: ['t1'] },
      { block_id: 'c2', block_type: 32, parent_id: 'tbl', children: ['t2'] },
      { block_id: 'c3', block_type: 32, parent_id: 'tbl', children: ['t3'] },
      { block_id: 'c4', block_type: 32, parent_id: 'tbl', children: ['t4'] },
      { block_id: 't1', block_type: 2, parent_id: 'c1', text: { elements: [textRun('A')] } },
      { block_id: 't2', block_type: 2, parent_id: 'c2', text: { elements: [textRun('B')] } },
      { block_id: 't3', block_type: 2, parent_id: 'c3', text: { elements: [textRun('C')] } },
      { block_id: 't4', block_type: 2, parent_id: 'c4', text: { elements: [textRun('D')] } },
    ]));

    assert.match(markdown, /^\| A \| B \|$/m);
    assert.match(markdown, /^\| --- \| --- \|$/m);
    assert.match(markdown, /^\| C \| D \|$/m);
  });

  it('renders a divider and a block quote', () => {
    const markdown = blocksToMarkdown(page([
      { block_id: 'd', block_type: 22, parent_id: 'page', divider: {} },
      { block_id: 'q', block_type: 15, parent_id: 'page', quote: { elements: [textRun('quoted')] } },
    ]));

    assert.match(markdown, /^---$/m);
    assert.match(markdown, /^> quoted$/m);
  });
});
