/**
 * The recording timeline: one append-only JSONL file per meeting, with a rebuildable index.
 *
 * Why append-only: a meeting's transcript is the raw evidence, while the note is a projection of it.
 * A rename or a merge never edits the timeline, it appends a correction; so a note can always be
 * recomputed from the same source, and a crash costs at most the last unfinished segment.
 *
 * The store takes an injected filesystem surface rather than importing `node:fs`, so its replay and
 * derivation rules are testable without touching a real disk.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { noteTimestamp } from './notes-format.ts';
import type { Speaker, Utterance, VoiceStatus } from './protocol.ts';

/** The filesystem surface the store needs; `node:fs/promises` satisfies it. */
export interface StoreFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  appendFile(path: string, data: string, options?: { mode?: number }): Promise<unknown>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, options?: { mode?: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
}

/** One line of a recording timeline. Every event carries the time it happened. */
export type TimelineEvent =
  | { kind: 'session'; at: number; sessionId: string; title: string; project?: string; startedAt: number }
  | { kind: 'speaker'; at: number; speaker: Speaker; centroid?: number[] }
  | { kind: 'utterance'; at: number; utterance: Utterance }
  | { kind: 'rename'; at: number; speakerId: string; name: string }
  | { kind: 'merge'; at: number; from: string; into: string }
  | { kind: 'status'; at: number; status: VoiceStatus }
  | { kind: 'enrolled'; at: number; speakerId: string; name: string };

/** A recording session as the index holds it: the header, the labels, the turns and the status. */
export interface SessionIndex {
  sessionId: string;
  title: string;
  project?: string;
  startedAt: number;
  updatedAt: number;
  status: VoiceStatus;
  speakers: Speaker[];
  /** Centroids in the same order as `speakers`, so a restart can keep the separation it had. */
  centroids: Array<number[] | undefined>;
  utterances: Utterance[];
  /** The last sequence number written, so a restart continues the numbering. */
  lastSequence: number;
}

/** Where a vault keeps its recording timelines; hidden, so it never shows up as notes. */
export function voiceDirectoryOf(vaultRoot: string): string {
  return join(vaultRoot, '.clawmaster', 'voice');
}

/** The timeline path of one session. */
export function timelinePathOf(vaultRoot: string, sessionId: string): string {
  return join(voiceDirectoryOf(vaultRoot), `${sessionId}.jsonl`);
}

/** A fresh session id. */
export function newSessionId(): string {
  return randomUUID();
}

/** A fresh utterance id, unique inside its session and stable across derivations. */
export function newUtteranceId(sequence: number): string {
  return `u${String(sequence).padStart(6, '0')}`;
}

/**
 * Derive a full index from a timeline.
 * Replaying is the only way state is built, so the in-memory state and a cold restart cannot drift.
 * @param text - The whole timeline file; blank lines and a torn last line are ignored.
 * @returns The index, or undefined when the timeline has no session header.
 */
export function replay(text: string): SessionIndex | undefined {
  let index: SessionIndex | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event: TimelineEvent;
    try {
      event = JSON.parse(trimmed) as TimelineEvent;
    } catch {
      // A process killed mid-append leaves one torn line; every earlier event still counts.
      continue;
    }
    if (!isEvent(event)) continue;
    if (event.kind === 'session') {
      index = {
        sessionId: event.sessionId,
        title: event.title,
        ...(event.project === undefined ? {} : { project: event.project }),
        startedAt: event.startedAt,
        updatedAt: event.at,
        status: 'listening',
        speakers: [],
        centroids: [],
        utterances: [],
        lastSequence: 0,
      };
      continue;
    }
    if (index === undefined) continue;
    index.updatedAt = event.at;
    switch (event.kind) {
      case 'speaker':
        index.speakers.push(event.speaker);
        index.centroids.push(event.centroid);
        break;
      case 'utterance':
        index.utterances.push(event.utterance);
        index.lastSequence = Math.max(index.lastSequence, parseSequence(event.utterance.id));
        break;
      case 'rename': {
        const target = index.speakers.find(speaker => speaker.id === event.speakerId);
        if (target !== undefined) {
          target.name = event.name;
          target.named = true;
        }
        // Every turn already recorded under the old label follows the rename, which is what makes
        // "who said this" answerable after the fact.
        for (const utterance of index.utterances) {
          if (utterance.speakerId === event.speakerId) utterance.speakerId = event.speakerId;
        }
        break;
      }
      case 'merge': {
        const from = index.speakers.findIndex(speaker => speaker.id === event.from);
        const into = index.speakers.findIndex(speaker => speaker.id === event.into);
        if (from >= 0 && into >= 0 && from !== into) {
          for (const utterance of index.utterances) {
            if (utterance.speakerId === event.from) utterance.speakerId = event.into;
          }
          const survivor = index.speakers[into]!;
          const absorbed = index.speakers[from]!;
          survivor.voiceprints += absorbed.voiceprints;
          survivor.lastHeardAt = Math.max(survivor.lastHeardAt, absorbed.lastHeardAt);
          index.speakers.splice(from, 1);
          index.centroids.splice(from, 1);
        }
        break;
      }
      case 'enrolled': {
        const target = index.speakers.find(speaker => speaker.id === event.speakerId);
        if (target !== undefined) {
          target.name = event.name;
          target.named = true;
          target.voiceprints += 1;
        }
        break;
      }
      case 'status':
        index.status = event.status;
        break;
    }
  }
  return index;
}

/**
 * Append-only writer for one session timeline, with a small in-memory index in front of it.
 * Every mutation appends first and updates memory second, so what the panel reads is always what
 * was durably recorded.
 */
export class TranscriptStore {
  private index: SessionIndex | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fs: StoreFs,
    readonly vaultRoot: string,
    readonly sessionId: string,
  ) {}

  /** The directory holding every timeline of this vault. */
  get directory(): string {
    return voiceDirectoryOf(this.vaultRoot);
  }

  /** The file this session appends to. */
  get path(): string {
    return timelinePathOf(this.vaultRoot, this.sessionId);
  }

  /** The current index, or undefined before the session header is written. */
  get current(): SessionIndex | undefined {
    return this.index;
  }

  /**
   * Open a new timeline and write its header.
   * @param title - What the meeting is called.
   * @param project - The project note to link from later, when the user named one.
   * @param at - Epoch milliseconds.
   */
  async open(title: string, project: string | undefined, at: number): Promise<SessionIndex> {
    await this.fs.mkdir(this.directory, { recursive: true });
    await this.append({ kind: 'session', at, sessionId: this.sessionId, title, ...(project === undefined ? {} : { project }), startedAt: at });
    const index = replay(await this.fs.readFile(this.path, 'utf8'));
    if (index === undefined) throw new Error('The voice timeline header could not be read back.');
    this.index = index;
    return index;
  }

  /**
   * Load an existing timeline from disk.
   * @returns The replayed index, or undefined when the timeline is missing or has no header.
   */
  async load(): Promise<SessionIndex | undefined> {
    let text: string;
    try {
      text = await this.fs.readFile(this.path, 'utf8');
    } catch {
      return undefined;
    }
    this.index = replay(text);
    return this.index;
  }

  /** Adopt an index that was replayed elsewhere, so the panel and the writer agree on state. */
  adopt(index: SessionIndex): void {
    this.index = index;
  }

  /** Record a discovered or renamed label. */
  async recordSpeaker(speaker: Speaker, centroid: number[] | undefined, at: number): Promise<void> {
    const index = this.requireIndex();
    await this.append({ kind: 'speaker', at, speaker, ...(centroid === undefined ? {} : { centroid }) });
    index.speakers.push({ ...speaker });
    index.centroids.push(centroid);
  }

  /** Record one recognized turn and return it with its assigned id. */
  async recordUtterance(utterance: Utterance, at: number): Promise<Utterance> {
    const index = this.requireIndex();
    await this.append({ kind: 'utterance', at, utterance });
    index.utterances.push(utterance);
    index.lastSequence = Math.max(index.lastSequence, parseSequence(utterance.id));
    return utterance;
  }

  /** Record a human rename. The label and every turn already written under it follow the new name. */
  async recordRename(speakerId: string, name: string, at: number): Promise<boolean> {
    const index = this.requireIndex();
    const target = index.speakers.find(speaker => speaker.id === speakerId);
    if (target === undefined) return false;
    await this.append({ kind: 'rename', at, speakerId, name });
    target.name = name;
    target.named = true;
    return true;
  }

  /** Record a merge of two labels into one. */
  async recordMerge(from: string, into: string, at: number): Promise<boolean> {
    const index = this.requireIndex();
    const fromIndex = index.speakers.findIndex(speaker => speaker.id === from);
    const intoIndex = index.speakers.findIndex(speaker => speaker.id === into);
    if (fromIndex < 0 || intoIndex < 0 || fromIndex === intoIndex) return false;
    await this.append({ kind: 'merge', at, from, into });
    for (const utterance of index.utterances) {
      if (utterance.speakerId === from) utterance.speakerId = into;
    }
    index.speakers.splice(fromIndex, 1);
    index.centroids.splice(fromIndex, 1);
    return true;
  }

  /** Record that a label was matched to an enrolled voiceprint. */
  async recordEnrollment(speakerId: string, name: string, at: number): Promise<void> {
    const index = this.requireIndex();
    const target = index.speakers.find(speaker => speaker.id === speakerId);
    if (target === undefined) return;
    await this.append({ kind: 'enrolled', at, speakerId, name });
    target.name = name;
    target.named = true;
    target.voiceprints += 1;
  }

  /** Record a status change, so a stopped meeting keeps its state after a restart. */
  async recordStatus(status: VoiceStatus, at: number): Promise<void> {
    const index = this.requireIndex();
    await this.append({ kind: 'status', at, status });
    index.status = status;
  }

  /** Wait for every append issued so far to reach the disk. */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * The index every mutation updates after its event is durable.
   * A missing index means the session header was never written, which is a programming error rather
   * than a silent no-op: a caller would otherwise believe a turn had been recorded when it had not.
   */
  private requireIndex(): SessionIndex {
    if (this.index === undefined) throw new Error('The voice timeline was not opened before it was written to.');
    return this.index;
  }

  private append(event: TimelineEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    this.queue = this.queue.then(async () => {
      await this.fs.mkdir(this.directory, { recursive: true });
      await this.fs.appendFile(this.path, line, { mode: 0o600 });
    });
    return this.queue as Promise<void>;
  }
}

/** The sequence number encoded in an utterance id, or 0 when the id does not carry one. */
export function parseSequence(id: string): number {
  const match = /^u(\d{1,9})$/.exec(id);
  return match === null ? 0 : Number(match[1]);
}

/** A one-line summary of a timeline for the panel and for the note header. */
export function summarize(index: SessionIndex): { turns: number; speakers: number; minutes: number; endedAt: number } {
  const last = index.utterances.at(-1);
  return {
    turns: index.utterances.length,
    speakers: index.speakers.length,
    minutes: Math.round(((last?.endMs ?? 0) / 60_000) * 10) / 10,
    endedAt: index.updatedAt,
  };
}

/** The file name a write-up of this session should get, using the note format's timestamp rules. */
export function writeUpName(index: SessionIndex): string {
  return `${noteTimestamp(index.startedAt)} ${sanitize(index.title)}.md`.trim();
}

/**
 * Replace characters that are awkward in a file name while keeping the title readable.
 * The note library uses `/` as its folder separator, so a title that contains one would otherwise
 * create a directory instead of a note.
 */
export function sanitize(title: string): string {
  const cleaned = title
    .replaceAll('/', ' ')
    .replaceAll('\\', ' ')
    .replace(/[:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? '录音' : cleaned.slice(0, 80);
}

function isEvent(value: unknown): value is TimelineEvent {
  const candidate = value as { kind?: unknown; at?: unknown };
  return typeof candidate.kind === 'string' && typeof candidate.at === 'number';
}
