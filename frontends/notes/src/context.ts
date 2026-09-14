/**
 * The memory bridge: the vault notes that look related to what the user just asked for.
 *
 * The note library and the agent's memory are one system only if a note the user already wrote can
 * reach the model without being asked for. This module is the whole retrieval policy, kept pure so
 * it can be measured: tokenize the request, match the tokens against the notes' names and paths,
 * and render a bounded block the host injects as context.
 *
 * It deliberately claims nothing more than a name match. Reading note bodies to rank them would
 * cost one file read per note per turn — a tax on every request in a large vault — and the model
 * can open any note this block names, which is the part that actually matters.
 * @module @clawmaster/dsh-notes/context
 */

import type { NoteEntry } from './protocol.ts';

/** Token that carries no retrieval signal, in either language the panel ships. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'are', 'was', 'were', 'have', 'has',
  'not', 'but', 'all', 'any', 'can', 'could', 'would', 'should', 'please', 'help', 'make', 'made',
  'now', 'then', 'than', 'into', 'from', 'out', 'our', 'its', 'his', 'her', 'their', 'them', 'use',
  '继续', '帮我', '一下', '现在', '这个', '那个', '什么', '怎么', '可以', '我们', '你们', '他们',
  '需要', '应该', '还是', '已经', '没有', '就是', '如果', '因为', '所以', '然后', '以及', '并且',
]);

/** Longest block one injection may carry, in characters, before it is trimmed with a count. */
export const MAX_CONTEXT_CHARS = 700;

/** Most tokens a request is reduced to, so one long paragraph cannot widen the search. */
export const MAX_CONTEXT_TOKENS = 8;

/** How many notes one injection may name. */
export const DEFAULT_CONTEXT_NOTES = 3;

/** One note that matches the request, with the strength of the match. */
export interface RelatedNote {
  /** Vault-relative id, which is what a reader would pass to `notes_query`. */
  id: string;
  /** Display title, equal to the id's basename unless the note's frontmatter overrides it. */
  title: string;
  /** Distinct tokens matched in the title (weighted double) and in the path. */
  score: number;
}

/**
 * Reduce one request to the tokens worth matching against note names.
 *
 * Latin words survive whole; a run of CJK has no spaces to split on, so it contributes its
 * two-character windows — the smallest unit that still carries meaning in Chinese.
 * @param text - The user's own words.
 * @returns Distinct tokens in first-seen order, at most {@link MAX_CONTEXT_TOKENS}.
 */
export function contextTokens(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const keep = (token: string): void => {
    if (token === '' || seen.has(token) || STOP_WORDS.has(token) || tokens.length >= MAX_CONTEXT_TOKENS) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word === '') continue;
    // A run of Han has no spaces to split on, so it contributes its two-character windows.
    for (const run of word.split(/[^\p{Script=Han}]+/u)) {
      for (let index = 0; index + 2 <= run.length; index += 1) keep(run.slice(index, index + 2));
    }
    // The latin runs of the same word survive whole, whichever side of the Han they sit on.
    for (const run of word.split(/[\p{Script=Han}]+/u)) {
      if (run.length >= 3) keep(run);
    }
  }
  return tokens;
}

/**
 * Rank the notes whose name or path matches the request.
 * @param entries - Every note in the vault, as the listing reports it.
 * @param tokens - Tokens from {@link contextTokens}.
 * @param limit - Most notes to return.
 * @returns Notes in descending score, newest first on a tie; a note must match its own title.
 */
export function rankRelated(entries: readonly NoteEntry[], tokens: readonly string[], limit: number): RelatedNote[] {
  if (tokens.length === 0 || limit <= 0) return [];
  const ranked: Array<{ note: RelatedNote; mtimeMs: number }> = [];
  for (const entry of entries) {
    const id = entry.id.toLowerCase();
    const title = entry.title.toLowerCase();
    if (!tokens.some(token => title.includes(token))) continue;
    let score = 0;
    for (const token of tokens) {
      if (title.includes(token)) score += 2;
      else if (id.includes(token)) score += 1;
    }
    ranked.push({ note: { id: entry.id, title: entry.title, score }, mtimeMs: entry.mtimeMs });
  }
  ranked.sort((left, right) => right.note.score - left.note.score
    || right.mtimeMs - left.mtimeMs
    || left.note.id.localeCompare(right.note.id, 'en'));
  return ranked.slice(0, limit).map(entry => entry.note);
}

/**
 * Render the bounded block the host injects, or the empty string when there is nothing to say.
 * @param notes - Ranked notes from {@link rankRelated}.
 * @param readMode - The `notes_query` mode that reads one note, named so the model can open it.
 * @returns The context text, or `''` when no note was named.
 */
export function renderRelatedNotes(notes: readonly RelatedNote[], readMode = 'read'): string {
  if (notes.length === 0) return '';
  const header = 'Related notes the user already keeps in the local vault (matched by note name).';
  const hint = `Open one with notes_query (mode: ${readMode}). Do not assume a note's contents from its name.`;
  const lines: string[] = [];
  let used = header.length + hint.length + 2;
  let dropped = 0;
  for (const note of notes) {
    const basename = note.id.replace(/^.*\//, '').replace(/\.md$/i, '');
    const line = note.title === basename ? `- ${note.id}` : `- ${note.title} (${note.id})`;
    if (used + line.length + 1 > MAX_CONTEXT_CHARS) {
      dropped += 1;
      continue;
    }
    used += line.length + 1;
    lines.push(line);
  }
  if (lines.length === 0) return '';
  const more = dropped > 0 ? `\n(${dropped} more matched but did not fit.)` : '';
  return `${header}\n${hint}\n${lines.join('\n')}${more}`;
}
