/**
 * Feishu docx blocks -> Markdown.
 *
 * Block type numbers follow the Feishu docx block model. A type this renderer does not
 * understand is emitted as an explicit HTML comment rather than dropped, so a lossy
 * conversion is always visible in the text a human reviews.
 *
 * Known gap: code fences carry no language tag because `style.language` is an enum whose
 * values are not yet verified against a real document. Recorded for the P2 acceptance run.
 */

/** Structural view of one docx block; unknown members are preserved but unused. */
export interface DocxBlock {
  readonly block_id?: string;
  readonly block_type?: number;
  readonly parent_id?: string;
  readonly children?: readonly string[];
  readonly [member: string]: unknown;
}

interface BlockContent {
  readonly elements?: readonly unknown[];
  readonly property?: { readonly column_size?: number };
  readonly style?: { readonly done?: boolean };
}

const FIELD_BY_TYPE: Readonly<Record<number, string>> = Object.freeze({
  1: 'page',
  2: 'text',
  3: 'heading1',
  4: 'heading2',
  5: 'heading3',
  6: 'heading4',
  7: 'heading5',
  8: 'heading6',
  9: 'heading7',
  10: 'heading8',
  11: 'heading9',
  12: 'bullet',
  13: 'ordered',
  14: 'code',
  15: 'quote',
  17: 'todo',
  19: 'callout',
  31: 'table',
  32: 'table_cell',
});

const HEADING_LEVEL: Readonly<Record<number, number>> = Object.freeze({
  3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 6, 10: 6, 11: 6,
});

const BLOCK_PAGE = 1;
const BLOCK_ORDERED = 13;
const BLOCK_TABLE_CELL = 32;

function contentField(block: DocxBlock): BlockContent | undefined {
  const field = FIELD_BY_TYPE[block.block_type ?? -1];
  if (field === undefined) return undefined;
  return block[field] as BlockContent | undefined;
}

interface TextRunElement {
  readonly content?: string;
  readonly text_element_style?: {
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly strikethrough?: boolean;
    readonly underline?: boolean;
    readonly inline_code?: boolean;
    readonly link?: { readonly url?: string };
  };
}

function plainText(elements: readonly unknown[] | undefined): string {
  if (!Array.isArray(elements)) return '';
  return elements
    .map(element => {
      const run = (element as { text_run?: TextRunElement } | null)?.text_run;
      return typeof run?.content === 'string' ? run.content : '';
    })
    .join('');
}

function inlineElementToMarkdown(element: unknown): string {
  if (element === null || typeof element !== 'object') return '';
  const record = element as Record<string, unknown>;

  const run = record.text_run as TextRunElement | undefined;
  if (run !== undefined) {
    let text = typeof run.content === 'string' ? run.content : '';
    if (text === '') return '';
    const style = run.text_element_style ?? {};
    if (style.inline_code === true) text = `\`${text}\``;
    if (style.bold === true) text = `**${text}**`;
    if (style.italic === true) text = `*${text}*`;
    if (style.strikethrough === true) text = `~~${text}~~`;
    if (style.underline === true) text = `<u>${text}</u>`;
    const url = style.link?.url;
    if (typeof url === 'string' && url !== '') text = `[${text}](${url})`;
    return text;
  }

  const mentionUser = record.mention_user as { readonly user_id?: string } | undefined;
  if (mentionUser !== undefined) return `@${mentionUser.user_id ?? 'user'}`;

  const mentionDoc = record.mention_doc as { readonly title?: string; readonly url?: string } | undefined;
  if (mentionDoc !== undefined) {
    const title = mentionDoc.title ?? 'doc';
    const url = mentionDoc.url ?? '';
    return url === '' ? title : `[${title}](${url})`;
  }

  const equation = record.equation as { readonly content?: string } | undefined;
  if (equation !== undefined) return `$${equation.content ?? ''}$`;

  const file = record.file as { readonly file_token?: string } | undefined;
  if (file !== undefined) return `[file](feishu-file:${file.file_token ?? ''})`;

  if (record.reminder !== undefined) return '<!-- reminder -->';
  return '';
}

export function inlineToMarkdown(elements: readonly unknown[] | undefined): string {
  if (!Array.isArray(elements)) return '';
  return elements.map(inlineElementToMarkdown).join('');
}

function childrenOf(block: DocxBlock, byId: ReadonlyMap<string, DocxBlock>): DocxBlock[] {
  const ids = Array.isArray(block.children) ? block.children : [];
  return ids
    .map(id => byId.get(id))
    .filter((child): child is DocxBlock => child !== undefined);
}

function renderChildren(block: DocxBlock, depth: number, byId: ReadonlyMap<string, DocxBlock>, out: string[]): void {
  let orderedIndex = 0;
  for (const child of childrenOf(block, byId)) {
    if (child.block_type === BLOCK_ORDERED) {
      orderedIndex += 1;
      renderBlock(child, depth, byId, out, orderedIndex);
    } else {
      orderedIndex = 0;
      renderBlock(child, depth, byId, out, undefined);
    }
  }
}

function renderTable(block: DocxBlock, byId: ReadonlyMap<string, DocxBlock>, out: string[]): void {
  const declaredColumns = contentField(block)?.property?.column_size;
  const cells = childrenOf(block, byId).filter(child => child.block_type === BLOCK_TABLE_CELL);
  if (cells.length === 0) return;

  const cellText = (cell: DocxBlock): string => childrenOf(cell, byId)
    .map(child => inlineToMarkdown(contentField(child)?.elements).trim())
    .filter(text => text !== '')
    .join(' ');

  const width = typeof declaredColumns === 'number' && Number.isInteger(declaredColumns) && declaredColumns > 0
    ? declaredColumns
    : cells.length;
  const rows: string[][] = [];
  for (let index = 0; index < cells.length; index += width) {
    rows.push(cells.slice(index, index + width).map(cellText));
  }
  const header = rows[0] ?? [];
  if (header.length === 0) return;
  out.push(`| ${header.join(' | ')} |`);
  out.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows.slice(1)) out.push(`| ${row.join(' | ')} |`);
  out.push('');
}

function renderBlock(
  block: DocxBlock,
  depth: number,
  byId: ReadonlyMap<string, DocxBlock>,
  out: string[],
  orderedIndex: number | undefined,
): void {
  const pad = '  '.repeat(depth);
  const type = block.block_type ?? -1;
  const content = contentField(block);
  const text = inlineToMarkdown(content?.elements);

  switch (type) {
    case 1:
      renderChildren(block, depth, byId, out);
      return;

    case 2:
      out.push(text, '');
      renderChildren(block, depth, byId, out);
      return;

    case 3: case 4: case 5: case 6: case 7: case 8: case 9: case 10: case 11:
      out.push(`${'#'.repeat(HEADING_LEVEL[type] ?? 1)} ${text}`, '');
      renderChildren(block, depth, byId, out);
      return;

    case 12:
      out.push(`${pad}- ${text}`);
      renderChildren(block, depth + 1, byId, out);
      return;

    case 13:
      out.push(`${pad}${orderedIndex ?? 1}. ${text}`);
      renderChildren(block, depth + 1, byId, out);
      return;

    case 14:
      out.push('```', plainText(content?.elements), '```', '');
      return;

    case 15: case 34:
      out.push(`${pad}> ${text}`, '');
      renderChildren(block, depth, byId, out);
      return;

    case 17:
      out.push(`${pad}- [${content?.style?.done === true ? 'x' : ' '}] ${text}`);
      renderChildren(block, depth + 1, byId, out);
      return;

    case 19:
      out.push(`> ${text}`, '');
      renderChildren(block, depth, byId, out);
      return;

    case 22:
      out.push('---', '');
      return;

    case 27:
      out.push(`![image](feishu-image:${block.block_id ?? ''})`, '');
      return;

    case 31:
      renderTable(block, byId, out);
      return;

    case 32:
      renderChildren(block, depth, byId, out);
      return;

    default:
      if (text !== '') out.push(text, '');
      else out.push(`<!-- unsupported block_type: ${type} -->`, '');
      renderChildren(block, depth, byId, out);
  }
}

/** Convert a flat docx block list into Markdown by walking the page/children tree. */
export function blocksToMarkdown(blocks: readonly DocxBlock[] | undefined, { title }: { title?: string } = {}): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';

  const byId = new Map<string, DocxBlock>();
  for (const block of blocks) {
    if (block !== null && typeof block?.block_id === 'string' && block.block_id !== '') byId.set(block.block_id, block);
  }

  const roots = blocks.filter(block => {
    if (block === null || typeof block !== 'object') return false;
    if (block.block_type === BLOCK_PAGE) return true;
    return typeof block.parent_id !== 'string' || !byId.has(block.parent_id);
  });

  const out: string[] = [];
  if (typeof title === 'string' && title.trim() !== '') out.push(`# ${title.trim()}`, '');
  for (const root of roots) renderBlock(root, 0, byId, out, undefined);

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
