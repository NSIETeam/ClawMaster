/** Browser-side Notes transport over the plugin's own authenticated Fetch routes. */
import {
  NOTES_ANNOTATIONS_PATH, NOTES_BACKLINKS_PATH, NOTES_COMMAND_PATH, NOTES_NOTE_PATH, NOTES_PROPOSALS_PATH, NOTES_REVISION_PATH, NOTES_SEARCH_PATH, NOTES_TAGS_PATH, NOTES_TREE_PATH,
  noteCommandSchema, noteReadSchema, noteReceiptSchema, notesAnnotationsSchema, notesBacklinksSchema, notesFailureSchema, notesProposalsSchema, notesRevisionSchema, notesSearchSchema, notesTagsSchema, notesTreeSchema,
  type NoteCommand, type NoteRead, type NoteReceipt, type NotesAnnotations, type NotesBacklinks, type NotesProposals, type NotesRevision, type NotesSearch, type NotesTags, type NotesTree,
} from './protocol.ts';

/** One rejected Notes call, carrying the server's failure code and conflict revision. */
export class NotesApiError extends Error {
  constructor(readonly code: string, message: string, readonly currentRevision?: string) {
    super(message);
    this.name = 'NotesApiError';
  }
}

/** Typed calls against the Notes routes; the carrier owns authentication. */
export class NotesApi {
  constructor(private readonly request: typeof fetch) {}

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.request(path, { credentials: 'same-origin', ...init });
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new NotesApiError('storage_unavailable', 'Notes response was not JSON.'); }
    if (!response.ok) {
      const failure = notesFailureSchema.safeParse(payload);
      if (failure.success) {
        throw new NotesApiError(failure.data.error.code, failure.data.error.message, failure.data.error.currentRevision);
      }
      throw new NotesApiError('storage_unavailable', `Notes request failed with ${response.status}.`);
    }
    return payload;
  }

  /** Every note in the vault. */
  async tree(): Promise<NotesTree> {
    return notesTreeSchema.parse(await this.call(NOTES_TREE_PATH));
  }

  /** One note with the revision a later save must present. */
  async read(id: string): Promise<NoteRead> {
    return noteReadSchema.parse(await this.call(`${NOTES_NOTE_PATH}?${new URLSearchParams({ id })}`));
  }

  /** Substring search bounded by the deployment limit. */
  async search(query: string, limit?: number): Promise<NotesSearch> {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set('limit', String(limit));
    return notesSearchSchema.parse(await this.call(`${NOTES_SEARCH_PATH}?${params}`));
  }

  /** Pending proposals with the diff each would apply. */
  async proposals(): Promise<NotesProposals> {
    return notesProposalsSchema.parse(await this.call(NOTES_PROPOSALS_PATH));
  }

  /** The current vault version, used to notice edits made outside this client. */
  async revision(): Promise<NotesRevision['version']> {
    return notesRevisionSchema.parse(await this.call(NOTES_REVISION_PATH)).version;
  }

  /** Every tag with its note count. */
  async tags(): Promise<NotesTags> {
    return notesTagsSchema.parse(await this.call(NOTES_TAGS_PATH));
  }

  /** Notes containing a link to the requested note. */
  async backlinks(id: string): Promise<NotesBacklinks> {
    return notesBacklinksSchema.parse(await this.call(`${NOTES_BACKLINKS_PATH}?${new URLSearchParams({ id })}`));
  }

  /** Marks a person or an agent left on one note. */
  async annotations(id: string): Promise<NotesAnnotations> {
    return notesAnnotationsSchema.parse(await this.call(`${NOTES_ANNOTATIONS_PATH}?${new URLSearchParams({ id })}`));
  }

  /** Apply one mutation; validated locally before the request leaves the page. */
  async command(request: NoteCommand): Promise<NoteReceipt> {
    const body = JSON.stringify({ request: noteCommandSchema.parse(request) });
    return noteReceiptSchema.parse(await this.call(NOTES_COMMAND_PATH, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }));
  }
}
