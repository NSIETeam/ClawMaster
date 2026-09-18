/**
 * The vault surface other ClawMaster plugins consume.
 *
 * The notes plugin owns every read and write of the vault, so a companion plugin — the WatchDog
 * reviewers, an archive writer, a memory bridge — must not reach for the filesystem itself: it
 * would duplicate the path policy, the revision discipline and the lock. This module publishes one
 * narrow access object on the harness context (`ctx.provide`), and consumers read it with
 * `ctx.get`. Writes stay the notes plugin's own: `digest` appends through the same
 * `appendOrCreate` path the agent tool uses, so the daily note keeps one writer and one revision
 * chain.
 * @module @clawmaster/dsh-notes/access
 */

import type { NotesHostContext } from './host.ts';
import type { NoteEntry, NoteMatch, NoteRead } from './protocol.ts';
import type { DigestEntry, NotesService } from './service.ts';
import type { VaultEntry } from './vault.ts';

/** Context key the notes host publishes its vault access under. */
export const NOTES_ACCESS_KEY = 'clawmasterNotes';

/** One tag with the number of notes carrying it. */
export interface NoteTagCount {
  tag: string;
  count: number;
}

/** What another plugin can do with the vault: read, search, and append a digested entry. */
export interface NotesAccess {
  /** Absolute vault root, so a consumer can label or link what it reads. */
  readonly root: string;
  /** Every note in the vault, in the vault's own deterministic order. */
  list(): Promise<NoteEntry[]>;
  /** One note with the revision a later write must present. */
  read(id: string): Promise<NoteRead>;
  /** Substring matches with their line numbers. */
  search(query: string, limit?: number): Promise<NoteMatch[]>;
  /** Notes that link to the requested note. */
  backlinks(id: string): Promise<VaultEntry[]>;
  /** Every tag with its note count. */
  tags(): Promise<NoteTagCount[]>;
  /** Append one composed entry to the day's note; returns the note it appended to. */
  digest(entry: DigestEntry): Promise<{ id: string; revision: string }>;
  /**
   * Create or replace one note on a companion's behalf.
   *
   * This is the only write a companion gets, and it goes through the vault's own append-or-create, so
   * the path policy, the lock and the revision chain stay the notes plugin's. A companion that must not
   * clobber a human edit reads the note first and sends the merged text back.
   * @param id - Vault-relative note id ending in `.md`.
   * @param text - The complete note body.
   * @returns The note id and the revision the write produced.
   */
  writeNote(id: string, text: string): Promise<{ id: string; revision: string; previousRevision: string | null }>;
}

/**
 * Build the access object over one open notes service.
 * @param service - The live notes service.
 * @param root - The vault root the service was opened on.
 * @returns The access object published on the context.
 */
export function createNotesAccess(service: NotesService, root: string): NotesAccess {
  return {
    root,
    async list() {
      return (await service.tree()).notes;
    },
    read: id => service.read(id),
    async search(query, limit) {
      return (await service.search(query, limit)).matches;
    },
    backlinks: id => service.backlinks(id),
    tags: () => service.tags(),
    async digest(entry) {
      const result = await service.digest(entry);
      return { id: result.id, revision: result.revision };
    },
    writeNote: (id, text) => service.writeFromCompanion(id, text),
  };
}

/**
 * Read the notes access another plugin published, if it is mounted.
 * @param ctx - Any harness context; one without a service registry yields undefined.
 * @returns The access object, or undefined when the notes plugin is not composed.
 */
export function notesAccessOf(ctx: Pick<NotesHostContext, 'get'>): NotesAccess | undefined {
  return ctx.get?.(NOTES_ACCESS_KEY) as NotesAccess | undefined;
}
