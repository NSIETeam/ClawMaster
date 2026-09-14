/**
 * Note annotations: what a person or an agent marked in a note, kept beside it.
 *
 * A note belongs to the vault; an annotation belongs to the vault's ignored metadata directory
 * (`.clawmaster/annotations`), one JSON file per annotation. That choice buys three things: the
 * note's own bytes are never rewritten to record a comment, two writers adding annotations cannot
 * clobber each other, and annotations stay invisible to an external editor browsing the vault —
 * the same containment the proposal store uses.
 *
 * The anchor is the pair the design asks for: a line number when the marker is positional, a short
 * quote when it is not, or neither for a note-level remark. The source is recorded because a note
 * the user wrote and an agent commented on must not be readable as the same thing.
 * @module @clawmaster/dsh-notes/annotations
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { annotationIdSchema, annotationSchema, annotateCommandSchema, type AnnotateCommand, type Annotation } from './protocol.ts';
import { VaultError, assertNoteId, type Vault } from './vault.ts';

export type { Annotation } from './protocol.ts';

/** Vault-relative directory holding annotations. */
export const ANNOTATION_DIRECTORY = '.clawmaster/annotations';

/** What a caller supplies to write one annotation. */
export type AnnotationDraft = AnnotateCommand;

/**
 * Validate one annotation draft, so a malformed mark fails before anything is written.
 * @param draft - The caller's draft.
 * @returns The parsed draft.
 * @throws VaultError when the draft is not a usable annotation.
 */
export function assertAnnotationDraft(draft: unknown): AnnotationDraft {
  const parsed = annotateCommandSchema.safeParse(draft);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || 'annotation'}: ${issue.message}`).join('; ');
    throw new VaultError('invalid_request', `An annotation needs a note id, a kind and a non-empty body (${detail}).`);
  }
  return parsed.data;
}

/** Read and write annotations for one vault. */
export class AnnotationStore {
  constructor(private readonly vault: Vault) {}

  private get directory(): string {
    return join(this.vault.root, ANNOTATION_DIRECTORY);
  }

  private path(annotationId: string): string {
    return join(this.directory, `${annotationIdSchema.parse(annotationId)}.json`);
  }

  /**
   * Write one annotation.
   * @param draft - The caller's draft; the note id is validated for path safety.
   * @param now - Clock, injectable so tests are deterministic.
   * @returns The stored annotation.
   */
  async add(draft: unknown, now: Date = new Date()): Promise<Annotation> {
    const parsed = assertAnnotationDraft(draft);
    const annotation: Annotation = {
      annotationId: randomUUID(),
      id: assertNoteId(parsed.id),
      line: parsed.line ?? null,
      quote: parsed.quote ?? null,
      kind: parsed.kind,
      source: parsed.source ?? 'ai',
      author: parsed.author ?? null,
      body: parsed.body,
      createdAt: now.toISOString(),
    };
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.path(annotation.annotationId), `${JSON.stringify(annotation, null, 2)}\n`, 'utf8');
    return annotation;
  }

  /**
   * Every annotation, or the annotations of one note.
   * @param id - Optional note id to filter by.
   * @returns Annotations in reading order: by line, then by note and time.
   */
  async list(id?: string): Promise<Annotation[]> {
    const wanted = id === undefined ? undefined : assertNoteId(id);
    let names: string[];
    try { names = await readdir(this.directory); }
    catch { return []; }
    const annotations: Annotation[] = [];
    for (const name of names.filter(name => name.endsWith('.json')).sort()) {
      try {
        const annotation = annotationSchema.parse(JSON.parse(await readFile(join(this.directory, name), 'utf8')));
        if (wanted === undefined || annotation.id === wanted) annotations.push(annotation);
      } catch { /* an unreadable annotation must not hide the readable ones */ }
    }
    return annotations.sort((left, right) => {
      const line = (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
      if (line !== 0) return line;
      if (left.id !== right.id) return left.id < right.id ? -1 : 1;
      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    });
  }

  /**
   * Remove one annotation.
   * @param annotationId - The annotation to remove.
   * @returns True when a file was removed, false when nothing matched.
   */
  async remove(annotationId: string): Promise<boolean> {
    const target = this.path(annotationId);
    try {
      await rm(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
