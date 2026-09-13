/** Notes wire contract: the authenticated Fetch paths and the validated payloads both halves share. */
import { z } from 'zod';

/** Authenticated DSH Fetch paths owned by the Notes plugin. */
export const NOTES_TREE_PATH = '/api/clawmaster/notes/tree';
export const NOTES_NOTE_PATH = '/api/clawmaster/notes/note';
export const NOTES_SEARCH_PATH = '/api/clawmaster/notes/search';
export const NOTES_TAGS_PATH = '/api/clawmaster/notes/tags';
export const NOTES_REVISION_PATH = '/api/clawmaster/notes/revision';
export const NOTES_PROPOSALS_PATH = '/api/clawmaster/notes/proposals';
export const NOTES_BACKLINKS_PATH = '/api/clawmaster/notes/backlinks';
export const NOTES_COMMAND_PATH = '/api/clawmaster/notes/command';

/** Largest note this version accepts; a bigger note fails explicitly rather than truncating. */
export const MAX_NOTE_BYTES = 1048576;

export const noteIdSchema = z.string().min(1).max(512);
export const revisionSchema = z.string().regex(/^sha256-[0-9a-f]{64}$/);
const noteTextSchema = z.string().max(MAX_NOTE_BYTES);

/** One listed note. */
export const noteEntrySchema = z.object({
  id: noteIdSchema, title: z.string(), dir: z.string(),
  size: z.number().int().min(0), mtimeMs: z.number().min(0),
}).strict();
export type NoteEntry = z.output<typeof noteEntrySchema>;

export const notesTreeSchema = z.object({ vault: z.string(), notes: z.array(noteEntrySchema) }).strict();
export type NotesTree = z.output<typeof notesTreeSchema>;

/** Notes that link to the requested note. */
export const notesBacklinksSchema = z.object({ id: noteIdSchema, notes: z.array(noteEntrySchema) }).strict();
export type NotesBacklinks = z.output<typeof notesBacklinksSchema>;

export const noteReadSchema = z.object({
  id: noteIdSchema, title: z.string(), text: z.string(), revision: revisionSchema,
  links: z.array(z.string()), embeds: z.array(z.string()), tags: z.array(z.string()),
}).strict();
export type NoteRead = z.output<typeof noteReadSchema>;

export const noteMatchSchema = z.object({
  id: noteIdSchema, title: z.string(), lineNumber: z.number().int().min(0), line: z.string(),
}).strict();
export type NoteMatch = z.output<typeof noteMatchSchema>;

export const notesSearchSchema = z.object({ query: z.string(), matches: z.array(noteMatchSchema) }).strict();
export type NotesSearch = z.output<typeof notesSearchSchema>;

/** Every tag in the vault with its note count. */
/** A proposal id is a generated UUID, validated before it reaches the filesystem. */
export const proposalIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** One stored proposal and the diff it would apply. */
export const proposalSchema = z.object({
  proposalId: proposalIdSchema,
  id: noteIdSchema,
  text: z.string(),
  baseRevision: revisionSchema.nullable(),
  createdAt: z.string(),
}).strict();
export type Proposal = z.output<typeof proposalSchema>;

export const diffLineSchema = z.object({
  kind: z.enum(['context', 'add', 'remove']), text: z.string(),
}).strict();
export const unifiedDiffSchema = z.object({
  lines: z.array(diffLineSchema), added: z.number().int().min(0), removed: z.number().int().min(0), truncated: z.boolean(),
}).strict();
export type UnifiedDiff = z.output<typeof unifiedDiffSchema>;
export const notesProposalsSchema = z.object({
  proposals: z.array(z.object({ proposal: proposalSchema, diff: unifiedDiffSchema }).strict()),
}).strict();
export type NotesProposals = z.output<typeof notesProposalsSchema>;

/** Opaque vault version; a change means some note file changed outside this client. */
export const notesRevisionSchema = z.object({ version: z.string().min(1) }).strict();
export type NotesRevision = z.output<typeof notesRevisionSchema>;

export const notesTagsSchema = z.object({
  tags: z.array(z.object({ tag: z.string(), count: z.number().int().min(1) }).strict()),
}).strict();
export type NotesTags = z.output<typeof notesTagsSchema>;

/** Every mutation the browser and the agent may perform on the vault. */
export const noteCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), id: noteIdSchema, text: noteTextSchema }).strict(),
  z.object({ action: z.literal('save'), id: noteIdSchema, text: noteTextSchema, expectedRevision: revisionSchema }).strict(),
  z.object({ action: z.literal('append'), id: noteIdSchema, text: noteTextSchema }).strict(),
  z.object({ action: z.literal('daily'), text: noteTextSchema, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
  z.object({ action: z.literal('rename'), id: noteIdSchema, to: noteIdSchema }).strict(),
  z.object({ action: z.literal('delete'), id: noteIdSchema }).strict(),
  z.object({ action: z.literal('apply-proposal'), proposalId: proposalIdSchema }).strict(),
  z.object({ action: z.literal('discard-proposal'), proposalId: proposalIdSchema }).strict(),
]);
export type NoteCommand = z.output<typeof noteCommandSchema>;
export const noteCommandEnvelopeSchema = z.object({ request: z.unknown() }).strict();

/** What one committed mutation did, with the revisions needed to undo it. */
export const noteReceiptSchema = z.object({
  action: z.string(), id: noteIdSchema,
  revision: revisionSchema.nullable(), previousRevision: revisionSchema.nullable(),
}).strict();
export type NoteReceipt = z.output<typeof noteReceiptSchema>;

export const notesFailureSchema = z.object({
  error: z.object({
    code: z.string(), message: z.string(), currentRevision: revisionSchema.optional(),
  }).strict(),
}).strict();
