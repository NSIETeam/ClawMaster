/**
 * The bridge from a recording to the notes vault.
 *
 * Voice does not touch the vault. The notes plugin owns every read and write of it — the path policy,
 * the lock and the revision chain — and publishes a narrow access handle for companion components. This
 * module consumes that handle, which is why a write-up cannot corrupt a note the vault also manages.
 *
 * The two writes a write-up performs:
 * 1. the meeting note itself, in the recording folder;
 * 2. one line in the day's journal that links to it, so the recording is reachable from the day it
 *    happened — the link is what makes the meeting note show up as a backlink.
 */
import { composeMeetingNote, mergeWithExisting, notePathFor, type WriteUpInput } from './meeting-note.ts';
import { timelinePathOf } from './store.ts';
import { noteTime } from './notes-format.ts';
import type { SessionIndex } from './store.ts';

/**
 * The slice of the notes plugin's access handle this bridge uses.
 * Declared structurally rather than imported so the voice package does not depend on the notes package,
 * which would couple two independently bundled front ends.
 */
export interface NotesWriter {
  /** Absolute vault root, so the note id can be checked and reported. */
  readonly root: string;
  /** One note with the revision a later write must present. */
  read(id: string): Promise<{ text: string }>;
  /** Create or replace one note through the vault's own append-or-create. */
  writeNote(id: string, text: string): Promise<{ id: string; revision: string; previousRevision: string | null }>;
  /** Append one composed entry to the day's note. */
  digest(entry: {
    date?: string;
    time?: string;
    project?: string;
    summary: string;
    decisions?: string[];
    evidence?: string[];
    nextSteps?: string[];
  }): Promise<{ id: string; revision: string }>;
}

/** What a completed write-up reports back to the panel and the agent tool. */
export interface WriteUpResult {
  /** The meeting note's vault id. */
  id: string;
  /** The revision the write produced. */
  revision: string;
  /** The day journal that links to it. */
  journalId: string;
  /** The journal's revision. */
  journalRevision: string;
  /** True when a note already existed and was replaced rather than created. */
  replaced: boolean;
  /** True when an edit a person had made under the marker was preserved. */
  keptHumanEdit: boolean;
  /** The vault root, for a caller that wants to show a path. */
  root: string;
}

/**
 * Write one recording into the vault.
 *
 * Repeating the call is safe and is the point: the meeting note is composed from the timeline each time,
 * so a speaker renamed in the panel is corrected by running this again, and a paragraph a person added
 * under the marker survives.
 * @param notes - The notes plugin's access handle.
 * @param input - The timeline, the writer's summary and the vault the note belongs to.
 * @returns What was written, including whether an existing note or a human edit was met.
 */
export async function writeUp(notes: NotesWriter, input: WriteUpInput): Promise<WriteUpResult> {
  const composed = composeMeetingNote({
    ...input,
    timelineName: input.timelineName ?? timelineNameOf(input.session),
  });
  let existing: string | undefined;
  try {
    existing = (await notes.read(composed.id)).text;
  } catch {
    // A missing note is the normal first write, and any other read failure still leaves a write that
    // the vault itself will refuse if the path policy disagrees.
  }
  const text = mergeWithExisting(composed.text, existing);
  const written = await notes.writeNote(composed.id, text);

  const journal = await notes.digest({
    time: noteTime(input.now ?? Date.now()),
    ...(input.session.project === undefined ? {} : { project: input.session.project }),
    summary: `${input.summary}（录音笔记 [[${composed.id.replace(/\.md$/, '')}]]）`,
    ...(input.decisions === undefined ? {} : { decisions: [...input.decisions] }),
    evidence: [`逐句时间轴：${timelineNameOf(input.session)}`],
    ...(input.nextSteps === undefined ? {} : { nextSteps: [...input.nextSteps] }),
  });

  return {
    id: written.id,
    revision: written.revision,
    journalId: journal.id,
    journalRevision: journal.revision,
    replaced: existing !== undefined,
    keptHumanEdit: existing !== undefined && mergeWithExisting(composed.text, existing) !== composed.text,
    root: notes.root,
  };
}

/** The vault-relative name of a session's timeline file, used in the note's evidence line. */
export function timelineNameOf(session: SessionIndex): string {
  return timelinePathOf('', session.sessionId).replace(/^[/\\]/, '');
}

/** The note id a session will be written to, without writing it; the panel shows it as a preview. */
export function previewNoteId(session: SessionIndex, directory?: string): string {
  return notePathFor(session, directory);
}
