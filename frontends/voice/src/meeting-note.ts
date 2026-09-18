/**
 * The meeting note: the projection of a recording timeline into the notes vault.
 *
 * The timeline is the evidence and the note is derived from it, so this module never mutates a note —
 * it builds the complete text from the timeline every time. That is what makes a rename in the panel
 * reach the note without editing it: the next write is composed from the corrected labels.
 *
 * The text is plain Markdown with the vault's own frontmatter keys, `#tags` and `[[wiki links]]`, so a
 * recording looks native next to a hand-written note rather than like an import.
 */
import { noteDate, noteTimestamp, recordingTags, renderFrontmatter, tidyText, timecode } from './notes-format.ts';
import type { SessionIndex } from './store.ts';

/**
 * The marker that separates the part a writer owns from the part a person may edit.
 *
 * Everything above it is composed from the timeline on every write and will be replaced; everything
 * below it belongs to the reader. A human who adds their own paragraph under the marker keeps it.
 */
export const BODY_MARKER = '<!-- clawmaster-voice:body -->';

/** What a write-up needs beyond the timeline itself. */
export interface WriteUpInput {
  /** The index replayed from the recording timeline. */
  session: SessionIndex;
  /** One or two sentences saying what the meeting was, in the writer's words. */
  summary: string;
  /** Decisions the meeting reached. */
  decisions?: readonly string[];
  /** Who attended, when it differs from the labels the timeline discovered. */
  participants?: readonly string[];
  /** What happens next. */
  nextSteps?: readonly string[];
  /** The folder inside the vault; recordings live in their own folder by default. */
  directory?: string;
  /** Epoch milliseconds the note is written at, for `updated`. */
  now?: number;
  /** The vault-visible name of the timeline file, so a reader can find the evidence. */
  timelineName?: string;
}

/** The vault-relative folder recordings are written into. */
export const RECORDING_DIRECTORY = '录音';

/** The note id a recording is written to: a dated title inside the recording folder. */
export function notePathFor(session: SessionIndex, directory = RECORDING_DIRECTORY): string {
  const safeTitle = session.title.replace(/[/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const name = safeTitle === '' ? '录音' : safeTitle.slice(0, 80);
  return `${directory}/${noteDate(session.startedAt)} ${name}.md`;
}

/**
 * Compose the complete meeting note.
 * @param input - The timeline plus the writer's summary and lists.
 * @returns The note text, frontmatter first and the reader's section last.
 */
export function composeMeetingNote(input: WriteUpInput): { id: string; text: string; title: string } {
  const { session } = input;
  const now = input.now ?? Date.now();
  const folder = input.directory ?? RECORDING_DIRECTORY;
  const id = notePathFor(session, folder);
  const title = session.title;
  const speakers = session.speakers;
  const turns = session.utterances;
  const nameOf = (speakerId: string): string => speakers.find(speaker => speaker.id === speakerId)?.name ?? speakerId;
  const attended = input.participants ?? speakers.map(speaker => speaker.name);
  const lastTurn = turns.at(-1);
  const duration = describeDuration(lastTurn?.endMs ?? 0);

  const lines: string[] = [];
  lines.push(renderFrontmatter({
    title,
    tags: recordingTags([folder, ...(session.project === undefined ? [] : [session.project]), '录音']),
    created: noteTimestamp(session.startedAt),
    updated: noteTimestamp(now),
    aliases: [`录音 ${noteDate(session.startedAt)}`],
    type: '录音',
  }).trimEnd());
  lines.push('', `# ${title}`, '');
  lines.push(`- 时间：${noteTimestamp(session.startedAt)}（${duration}，${turns.length} 句）`);
  lines.push(`- 说话人：${attended.length === 0 ? '（未分离）' : attended.join('、')}`);
  if (session.project !== undefined) lines.push(`- 项目：[[${session.project}]]`);
  if (input.timelineName !== undefined) lines.push(`- 逐句时间轴：\`${input.timelineName}\``);
  lines.push('', '## 摘要', '', tidyText(input.summary));
  lines.push(...listSection('决定', input.decisions));
  lines.push(...listSection('下一步', input.nextSteps));
  lines.push('', '## 逐句记录', '');
  if (turns.length === 0) lines.push('（没有识别到内容。）');
  // One line per turn, so the transcript reads as a conversation and stays diff-friendly: a later
  // correction changes one line rather than reformatting the note.
  for (const turn of turns) {
    const text = tidyText(turn.text);
    lines.push(`- \`${timecode(turn.startMs)}\` **${nameOf(turn.speakerId)}**：${text === '' ? '（未识别到内容）' : text}`);
  }
  if (speakers.some(speaker => !speaker.named)) {
    lines.push('', `> 仍有自动编号的说话人：${speakers.filter(speaker => !speaker.named).map(speaker => speaker.name).join('、')}。在语音面板里改名后再次生成即可。`);
  }
  lines.push('', BODY_MARKER, '');
  return { id, text: `${lines.join('\n')}\n`, title };
}

/**
 * How long a recording ran, in the unit that reads naturally.
 * A short test clip is seconds, a real meeting is minutes, and neither should be rounded into the
 * other — "0 分钟" tells a reader nothing.
 * @param ms - Milliseconds since the recording started at its last turn.
 * @returns A phrase like `42 秒` or `12.5 分钟`.
 */
export function describeDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10} 秒`;
  return `${Math.round((ms / 60_000) * 10) / 10} 分钟`;
}

/** One bullet section, omitted entirely when there is nothing to say. */
function listSection(heading: string, items: readonly string[] | undefined): string[] {
  const kept = (items ?? []).map(tidyText).filter(item => item !== '');
  if (kept.length === 0) return [];
  return ['', `## ${heading}`, '', ...kept.map(item => `- ${item}`)];
}

/**
 * Merge a new composition with a note a person has already annotated.
 *
 * The composed part is authoritative because it is derived; anything a human added under the marker is
 * kept, because it is the only part of the note that exists nowhere else.
 * @param composed - The freshly composed text.
 * @param existing - The note currently on disk, when it exists.
 * @returns The text to write.
 */
export function mergeWithExisting(composed: string, existing: string | undefined): string {
  if (existing === undefined) return composed;
  const marker = existing.indexOf(BODY_MARKER);
  if (marker < 0) return composed;
  const tail = existing.slice(marker + BODY_MARKER.length);
  if (tail.trim() === '') return composed;
  // Exactly one newline joins the composed part to the reader's part, so repeated write-ups do not
  // accumulate blank lines above a human's paragraph.
  return `${composed.trimEnd()}\n${tail.replace(/^\n+/, '')}`;
}
