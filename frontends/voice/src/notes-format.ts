/**
 * The note format this component writes.
 *
 * The built-in notes vault uses plain Markdown with YAML frontmatter, #tags and [[wiki links]]; a
 * recording write-up must look native in it, so the format lives here as pure functions instead of
 * being assembled inline where it could drift from the vault's conventions.
 */

/** The frontmatter keys the vault uses, in the order its notes write them. */
export interface NoteFrontmatter {
  title: string;
  tags: readonly string[];
  created: string;
  updated: string;
  aliases?: readonly string[];
  type?: string;
}

/** Local calendar date as YYYY-MM-DD. */
export function noteDate(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Local time as HH:MM. */
export function noteTime(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Local date and time as YYYY-MM-DD HH:MM. */
export function noteTimestamp(at: number | Date): string {
  return `${noteDate(at)} ${noteTime(at)}`;
}

/** Milliseconds since the start of a recording as HH:MM:SS, which is how a transcript reads. */
export function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const body = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours === 0 ? body : `${String(hours).padStart(2, '0')}:${body}`;
}

/** Render frontmatter as the vault's notes expect it, including the fences. */
export function renderFrontmatter(data: NoteFrontmatter): string {
  const lines = ['---', `title: ${quote(data.title)}`, `tags: ${renderTags(data.tags)}`, `created: ${data.created}`, `updated: ${data.updated}`];
  if (data.aliases !== undefined && data.aliases.length > 0) lines.push(`aliases: [${data.aliases.map(quote).join(', ')}]`);
  if (data.type !== undefined) lines.push(`type: ${data.type}`);
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/** Render tags as a YAML flow list; an empty list is still a valid value. */
function renderTags(tags: readonly string[]): string {
  return tags.length === 0 ? '[]' : `[${tags.join(', ')}]`;
}

/** Quote a scalar when it would otherwise be ambiguous YAML. */
function quote(value: string): string {
  return /^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff _.,()（）\-/]*$/.test(value) ? value : JSON.stringify(value);
}

/** Collapse whitespace and trim, so a transcript line never carries the engine's padding. */
export function tidyText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A tag set for a recording, deriving stable tags from the title and project. */
export function recordingTags(tags: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag === undefined) continue;
    const cleaned = tag.replace(/\s+/g, '').replace(/^#/, '');
    if (cleaned !== '') seen.add(cleaned);
  }
  return [...seen];
}
