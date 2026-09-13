/**
 * Pure note text format: frontmatter, link facts and titles.
 * Imports no Node built-in so the browser bundle can share it with the vault.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Parsed note head: the verbatim block, its flat scalars and the remaining body. */
export interface Frontmatter { raw: string | undefined; data: Record<string, string | string[]>; body: string }

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scalar(value: string): string | string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map(item => unquote(item)).filter(item => item !== '');
  }
  return unquote(trimmed);
}

/**
 * Read the leading YAML head without ever rewriting it: unknown or nested
 * structures stay in `raw` and survive a round trip byte for byte.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = FRONTMATTER.exec(text);
  if (!match) return { raw: undefined, data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const entry = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    const key = entry?.[1];
    const raw = entry?.[2];
    if (key !== undefined && raw !== undefined && raw.trim() !== '') data[key] = scalar(raw);
  }
  return { raw: match[0], data, body: text.slice(match[0].length) };
}

function stringList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === '' ? [] : [value];
}

/** Strip an alias, a heading anchor and a block reference from a wiki link target. */
export function normalizeTarget(raw: string): string {
  const [withoutAlias = ''] = raw.split('|', 1);
  const [withoutAnchor = ''] = withoutAlias.split('#', 1);
  return withoutAnchor.replace(/\^[^\s\]]*$/, '').trim();
}

function targets(text: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const target = normalizeTarget(match[1] ?? '');
    if (target !== '') found.add(target);
  }
  return [...found].sort();
}

/** Drop fenced code blocks so sample links and tags are not counted as real ones. */
function stripFencedCode(text: string): string {
  return text.replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$/gm, '');
}

/** Link facts one note contributes to the graph. */
export interface NoteLinks { links: string[]; embeds: string[]; tags: string[] }

/** Extract outgoing wiki links, embeds and tags, including frontmatter tags. */
export function extractLinks(text: string): NoteLinks {
  const { data, body } = parseFrontmatter(text);
  const scannable = stripFencedCode(body);
  const tags = new Set<string>(stringList(data.tags).map(tag => tag.replace(/^#/, '')).filter(tag => tag !== ''));
  for (const match of scannable.matchAll(/(?:^|[\s(])#([^\s#[\]()]+)/g)) tags.add(match[1] ?? '');
  return {
    links: targets(scannable, /(?<!!)\[\[([^\]]+)\]\]/g),
    embeds: targets(scannable, /!\[\[([^\]]+)\]\]/g),
    tags: [...tags].sort(),
  };
}

/** Display title: declared frontmatter title, else the first heading, else the file name. */
export function noteTitle(id: string, data: Record<string, string | string[]>, body: string): string {
  const declared = data.title;
  const single = Array.isArray(declared) ? declared[0] : declared;
  if (typeof single === 'string' && single.trim() !== '') return single.trim();
  const heading = /^#[ \t]+(.+)$/m.exec(body);
  if (heading) return (heading[1] ?? '').trim();
  return (id.split('/').pop() ?? id).replace(/\.(md|canvas)$/, '');
}
