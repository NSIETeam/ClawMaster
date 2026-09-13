/**
 * Minimal Markdown block model for the notes preview.
 * Produces data only — no HTML string is built and no input is trusted as markup.
 */
import { parseFrontmatter } from './note-format.ts';

export type BlockKind = 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'rule';

/** One rendered block of a note body. */
export interface Block {
  kind: BlockKind;
  /** Heading level 1-6, only for `heading`. */
  level?: number;
  /** Info string of a fenced block, only for `code`; empty when absent. */
  language?: string;
  /** Heading, paragraph or quote text; empty for lists, rules and code. */
  text: string;
  /** Item texts, only for `list`. */
  items?: string[];
  /** Whether a list is numbered. */
  ordered?: boolean;
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const FENCE = /^[ \t]*```([^\s`]*)[ \t]*$/;
const RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const ORDERED = /^[ \t]*\d+[.)][ \t]+(.*)$/;
const QUOTE = /^[ \t]*>[ \t]?(.*)$/;

/** Split a note into blocks, ignoring any frontmatter head. */
export function parseMarkdown(text: string): Block[] {
  const { body } = parseFrontmatter(text);
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let items: string[] = [];
  let ordered = false;
  let fence: string | undefined;
  let code: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) { blocks.push({ kind: 'paragraph', text: paragraph.join('\n') }); paragraph = []; }
  };
  const flushQuote = (): void => {
    if (quote.length > 0) { blocks.push({ kind: 'quote', text: quote.join('\n') }); quote = []; }
  };
  const flushList = (): void => {
    if (items.length > 0) { blocks.push({ kind: 'list', text: '', items, ordered }); items = []; ordered = false; }
  };
  const flushOpen = (): void => { flushParagraph(); flushQuote(); flushList(); };

  for (const line of body.split(/\r?\n/)) {
    if (fence !== undefined) {
      if (FENCE.test(line)) { blocks.push({ kind: 'code', text: code.join('\n'), language: fence }); code = []; fence = undefined; }
      else code.push(line);
      continue;
    }
    const opening = FENCE.exec(line);
    if (opening) { flushOpen(); fence = opening[1] ?? ''; continue; }
    if (line.trim() === '') { flushOpen(); continue; }
    const heading = HEADING.exec(line);
    if (heading) { flushOpen(); blocks.push({ kind: 'heading', level: (heading[1] ?? '').length, text: (heading[2] ?? '').trim() }); continue; }
    if (RULE.test(line)) { flushOpen(); blocks.push({ kind: 'rule', text: '' }); continue; }
    const quoted = QUOTE.exec(line);
    if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1] ?? ''); continue; }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph(); flushQuote();
      if (ordered && items.length > 0) flushList();
      ordered = false; items.push(bullet[1] ?? ''); continue;
    }
    const numbered = ORDERED.exec(line);
    if (numbered) {
      flushParagraph(); flushQuote();
      if (!ordered && items.length > 0) flushList();
      ordered = true; items.push(numbered[1] ?? ''); continue;
    }
    flushQuote(); flushList();
    paragraph.push(line);
  }
  if (fence !== undefined) {
    // An unterminated fence swallows the file's final newline; drop it so both paths agree.
    if (code.at(-1) === '') code.pop();
    blocks.push({ kind: 'code', text: code.join('\n'), language: fence });
  }
  flushOpen();
  return blocks;
}

export type InlineKind = 'text' | 'strong' | 'code' | 'wiki';

/** One inline run of a block's text. */
export interface InlineToken {
  kind: InlineKind;
  /** Display text. */
  text: string;
  /** Link target of a `wiki` run, without alias or heading. */
  target?: string;
}

const INLINE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]|`([^`]+)`|\*\*([^*]+)\*\*/g;

/** Split inline text into plain, strong, code and wiki-link runs. */
export function inlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > index) tokens.push({ kind: 'text', text: text.slice(index, at) });
    if (match[1] !== undefined) tokens.push({ kind: 'wiki', text: (match[2] ?? match[1]).trim(), target: match[1].trim() });
    else if (match[3] !== undefined) tokens.push({ kind: 'code', text: match[3] });
    else tokens.push({ kind: 'strong', text: match[4] ?? '' });
    index = at + match[0].length;
  }
  if (index < text.length) tokens.push({ kind: 'text', text: text.slice(index) });
  return tokens;
}
