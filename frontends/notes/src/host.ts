/**
 * Built-in Notes vault: authenticated Fetch routes plus approval-gated agent tools.
 * Tool definitions and approvals use DSH's public types; the Fetch carrier owns authentication.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type ApprovalService from '@deepseek-ai/dsh-user-approval';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  NOTES_ANNOTATIONS_PATH, NOTES_BACKLINKS_PATH, NOTES_COMMAND_PATH, NOTES_NOTE_PATH, NOTES_PROPOSALS_PATH, NOTES_REVISION_PATH, NOTES_SEARCH_PATH, NOTES_TAGS_PATH, NOTES_TREE_PATH,
  MAX_ANNOTATION_CHARS, MAX_NOTE_BYTES, MAX_QUOTE_CHARS, annotationEnvelopeSchema, annotationIdSchema, annotationKindSchema, annotationSourceSchema, noteCommandEnvelopeSchema, noteCommandSchema, notesFailureSchema,
  type AnnotationRequest,
} from './protocol.ts';
import { DEFAULT_CONTEXT_NOTES, contextTokens, rankRelated, renderRelatedNotes } from './context.ts';
import { DEFAULT_LIMITS, NotesService, commandSummary, type NotesLimits } from './service.ts';
import { VaultError, openVault, type VaultEntry } from './vault.ts';
import { VaultWatcher } from './watcher.ts';
import { NOTES_ACCESS_KEY, createNotesAccess } from './access.ts';

export const name = 'clawmaster-notes';
export const inject = ['connection', 'tools', 'approval'];

/** One route on DSH's authenticated Fetch carrier, which owns authentication and origin checks. */
export interface NotesFetchRegistry {
  register(route: {
    path: string;
    methods: readonly ('GET' | 'POST')[];
    requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void>;
}

/** The execution context supplied by the DSH tool registry. */
export type NotesToolRun = ToolRunContext;

/** The tool definition accepted by the DSH registry. */
export type NotesToolDefinition = ToolDefinition;

/** The public DSH services this plugin consumes. */
export interface NotesHostContext {
  connection: { fetch: NotesFetchRegistry };
  tools: Pick<ToolRuntime, 'register'>;
  approval: Pick<ApprovalService, 'request'>;
  effect: Context['effect'];
  /**
   * Publish the vault access companion plugins read with `get`. Optional: the plugin's declared
   * injections are the Fetch, tool and approval services, so a host without a service registry
   * still gets every route and tool — it only loses the shared access handle.
   */
  provide?(name: string, value: unknown): void;
  /** Read a value another plugin published. */
  get?(name: string): unknown;
  /**
   * Ride the agent's step waterfall (`agent/pre-step`). Optional: without it every route and tool
   * still works, the vault just never volunteers a note of its own accord.
   */
  on?(event: 'agent/pre-step', listener: NotesStepListener): void | (() => void);
  /** Host logger, used when the memory bridge has to stand down. */
  logger?: { warn(message: string): void };
}

/** One message as the step waterfall hands it over; only the fields the bridge reads. */
export interface NotesStepMessage {
  role?: string;
  source?: { kind?: string };
  content?: unknown;
}

/** The agent step the memory bridge inspects before the model sees the request. */
export interface NotesStepPayload {
  /** The agent the step belongs to, used as the identity a note is announced to once. */
  agent: object;
  messages: readonly NotesStepMessage[];
  turn: number;
  step: number;
  signal?: AbortSignal;
}

/** What a step listener may return: refuse the step, or enter it with the messages to send. */
export type NotesStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: readonly NotesStepMessage[] };

/** A step listener, shaped like DSH's `agent/pre-step` waterfall. */
export type NotesStepListener = (
  payload: NotesStepPayload,
  next: () => Promise<NotesStepDecision>,
) => Promise<NotesStepDecision>;

/**
 * The last thing the human asked for, which is what the vault is matched against.
 * @param messages - The messages the step is about to send.
 * @returns The text of the newest human message, or undefined when the step has none.
 */
export function requestTextOf(messages: readonly NotesStepMessage[]): string | undefined {
  const human = [...messages].reverse().find(message => message.source?.kind === 'user');
  return human === undefined ? undefined : textOfContent(human.content);
}

/** The plain text of a message's content, whether it is one string or a block list. */
function textOfContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() === '' ? undefined : content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap(block => {
    if (typeof block !== 'object' || block === null) return [];
    const candidate = block as { type?: unknown; text?: unknown };
    return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : [];
  });
  const text = parts.join('\n').trim();
  return text === '' ? undefined : text;
}

const limitsSchema = z.object({
  maxReadBytes: z.number().int().min(1024).default(DEFAULT_LIMITS.maxReadBytes),
  maxSearchResults: z.number().int().min(1).max(200).default(DEFAULT_LIMITS.maxSearchResults),
  maxTreeEntries: z.number().int().min(1).default(DEFAULT_LIMITS.maxTreeEntries),
}).strict();

const configSchema = z.object({
  /** Absolute vault directory. Deployment-varying, so it is configuration, never a constant. */
  vaultRoot: z.string().min(1).optional(),
  limits: limitsSchema.optional(),
  /**
   * Memory bridge: `related` names the vault notes whose names match each new request and hands
   * them to the model as context, so a note the user already wrote is reachable without being asked
   * for. `off` serves the vault without ever volunteering a note.
   */
  notesContext: z.enum(['off', 'related']).default('off'),
  /** Most notes one injection may name. */
  maxContextNotes: z.number().int().min(1).max(10).default(DEFAULT_CONTEXT_NOTES),
}).strict();

export type NotesHostConfig = z.input<typeof configSchema>;

/**
 * Default vault location: a real user documents folder.
 * Never DSH home, the bundle directory or a session workspace, which are runtime state.
 */
export function defaultVaultRoot(platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  return platform === 'darwin' ? join(home, 'Documents', 'ClawMaster 笔记') : join(home, 'ClawMasterNotes');
}

const querySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('tree') }).strict(),
  z.object({ mode: z.literal('read'), id: z.string().min(1).max(512) }).strict(),
  z.object({ mode: z.literal('search'), query: z.string().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }).strict(),
  z.object({ mode: z.literal('backlinks'), id: z.string().min(1).max(512) }).strict(),
  z.object({ mode: z.literal('tags') }).strict(),
  z.object({ mode: z.literal('proposals') }).strict(),
  z.object({ mode: z.literal('annotations'), id: z.string().min(1).max(512).optional() }).strict(),
]);

const proposeSchema = z.object({
  id: z.string().min(1).max(512),
  text: z.string().max(MAX_NOTE_BYTES),
}).strict();

const digestSchema = z.object({
  summary: z.string().min(1).max(4000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  project: z.string().min(1).max(200).optional(),
  decisions: z.array(z.string().max(1000)).max(50).optional(),
  evidence: z.array(z.string().max(1000)).max(50).optional(),
  nextSteps: z.array(z.string().max(1000)).max(50).optional(),
}).strict();

const text = (description: string): Record<string, unknown> => ({ type: 'string', description });

/** One annotation mutation as the agent tool takes it: flat, so the model needs no envelope. */
const annotateSchema = z.object({
  action: z.enum(['add', 'remove']),
  id: z.string().min(1).max(512).optional(),
  body: z.string().min(1).max(MAX_ANNOTATION_CHARS).optional(),
  kind: annotationKindSchema.optional(),
  source: annotationSourceSchema.optional(),
  author: z.string().min(1).max(120).optional(),
  line: z.number().int().min(1).optional(),
  quote: z.string().min(1).max(MAX_QUOTE_CHARS).optional(),
  annotationId: annotationIdSchema.optional(),
}).strict();

const annotateParameters: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['add', 'remove'], description: 'Add a mark, or remove a stored one.' },
    id: text('Note the mark belongs to (add).'),
    body: text('The mark itself (add).'),
    kind: { type: 'string', enum: ['comment', 'highlight', 'todo', 'risk'], description: 'What the mark means: a remark, a highlight, a to-do, or a risk (add).' },
    source: { type: 'string', enum: ['human', 'ai'], description: 'Who wrote it; defaults to ai (add).' },
    author: text('Who or what wrote it — a person, or the model id (add).'),
    line: { type: 'integer', minimum: 1, description: '1-based line the mark sits on (add).' },
    quote: text('Quoted text the mark is about, when no line anchors it (add).'),
    annotationId: text('The annotation to remove (remove).'),
  },
};

const annotateOutput: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'annotation'],
  properties: {
    action: { type: 'string' },
    annotation: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
  },
};
const noteId = text('Vault-relative note path ending in .md, e.g. "项目/ClawMaster.md".');

const queryParameters: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['tree', 'read', 'search', 'backlinks', 'tags', 'proposals', 'annotations'], description: 'Which read to perform.' },
    id: noteId,
    query: text('Case-insensitive substring to search for.'),
    limit: { type: 'integer', description: 'Maximum hits; clamped by the deployment limit.' },
  },
};

const queryOutput: Record<string, unknown> = { type: 'object', additionalProperties: true };

const proposeParameters: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'text'],
  properties: {
    id: noteId,
    text: text('The complete proposed note body.'),
  },
};

const proposeOutput: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['proposal', 'diff'],
  properties: {
    proposal: { type: 'object', additionalProperties: true, description: 'proposalId, target id, baseRevision and createdAt.' },
    diff: { type: 'object', additionalProperties: true, description: 'Line diff with added and removed counts.' },
  },
};

const digestParameters: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: text('What was done, in one or two sentences.'),
    date: text('Local date YYYY-MM-DD; defaults to today.'),
    time: text('Local time HH:MM; defaults to now.'),
    project: text('Project name; linked to its note when one matches.'),
    decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions taken.' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Evidence a reader can check.' },
    nextSteps: { type: 'array', items: { type: 'string' }, description: 'What happens next.' },
  },
};

const digestOutput: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'markdown', 'revision', 'previousRevision'],
  properties: {
    id: { type: 'string' },
    markdown: { type: 'string' },
    revision: { type: 'string' },
    previousRevision: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

const commandParameters: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['request'],
  properties: {
    request: {
      description: 'The vault mutation to apply.',
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['action', 'id', 'text'], properties: { action: { type: 'string', const: 'create' }, id: noteId, text: text('Full note content.') } },
        { type: 'object', additionalProperties: false, required: ['action', 'id', 'text', 'expectedRevision'], properties: { action: { type: 'string', const: 'save' }, id: noteId, text: text('Replacement content.'), expectedRevision: text('Revision returned by the last read.') } },
        { type: 'object', additionalProperties: false, required: ['action', 'id', 'text'], properties: { action: { type: 'string', const: 'append' }, id: noteId, text: text('Text appended at the end.') } },
        { type: 'object', additionalProperties: false, required: ['action', 'text'], properties: { action: { type: 'string', const: 'daily' }, text: text('Entry appended to the daily note.'), date: text('Local date YYYY-MM-DD; defaults to today.') } },
        { type: 'object', additionalProperties: false, required: ['action', 'id', 'to'], properties: { action: { type: 'string', const: 'rename' }, id: noteId, to: noteId } },
        { type: 'object', additionalProperties: false, required: ['action', 'id'], properties: { action: { type: 'string', const: 'delete' }, id: noteId } },
        { type: 'object', additionalProperties: false, required: ['action', 'proposalId'], properties: { action: { type: 'string', const: 'apply-proposal' }, proposalId: text('Id returned by notes_propose.') } },
        { type: 'object', additionalProperties: false, required: ['action', 'proposalId'], properties: { action: { type: 'string', const: 'discard-proposal' }, proposalId: text('Id returned by notes_propose.') } },
      ],
    },
  },
};

const receiptOutput: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'id', 'revision', 'previousRevision'],
  properties: {
    action: { type: 'string' },
    id: { type: 'string' },
    revision: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    previousRevision: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

function failureCode(error: unknown): string {
  if (error instanceof VaultError) return error.code;
  if (error instanceof z.ZodError) return 'invalid_request';
  return 'storage_unavailable';
}

function errorResponse(error: unknown): Response {
  const code = failureCode(error);
  const status = code === 'not_found' ? 404
    : code === 'conflict' ? 409
      : code === 'invalid_path' || code === 'invalid_request' ? 400
        : 503;
  const message = error instanceof VaultError ? error.message
    : error instanceof z.ZodError ? 'Notes request fields are invalid.'
      : 'Notes storage is unavailable.';
  const body = notesFailureSchema.parse({
    error: {
      code,
      message,
      ...(error instanceof VaultError && error.currentRevision !== undefined
        ? { currentRevision: error.currentRevision } : {}),
    },
  });
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/** Run one read against the vault. */
export async function runQuery(service: NotesService, value: unknown): Promise<unknown> {
  const query = querySchema.parse(value);
  switch (query.mode) {
    case 'tree': return service.tree();
    case 'read': return service.read(query.id);
    case 'search': return service.search(query.query, query.limit);
    case 'backlinks': return { id: query.id, notes: await service.backlinks(query.id) as VaultEntry[] };
    case 'tags': return { tags: await service.tags() };
    case 'proposals': return { proposals: await service.pendingProposals() };
    case 'annotations': return service.annotationsOf(query.id);
  }
}

/**
 * Open the vault and register its routes and tools for the plugin lifetime.
 * @param ctx - DSH Fetch, tool and approval services.
 * @param config - Optional absolute vault root and query bounds.
 */
export async function apply(ctx: NotesHostContext, config: NotesHostConfig = {}): Promise<void> {
  const options = configSchema.parse(config);
  const root = options.vaultRoot ?? defaultVaultRoot();
  if (!isAbsolute(root)) throw new Error('Notes vault root must be an absolute path.');
  const limits: NotesLimits = options.limits ?? DEFAULT_LIMITS;
  await ctx.effect(async () => {
    const service = new NotesService(await openVault(root), limits);
    const watcher = await VaultWatcher.open(root);
    // Companion plugins — the WatchDog reviewers, an archive writer, a memory bridge — consume the
    // vault through this handle instead of opening the directory themselves and duplicating the
    // path policy, the lock and the revision discipline.
    ctx.provide?.(NOTES_ACCESS_KEY, createNotesAccess(service, root));
    const disposers: Array<() => Promise<void>> = [];
    const removals: Array<() => void> = [];
    const pending = new Set<Promise<unknown>>();
    const lifetime = new AbortController();
    let closing = false;
    let disposal: Promise<void> | undefined;

    const track = <T,>(operation: Promise<T>): Promise<T> => {
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    };
    const runTool = (exec: ToolRunContext, action: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> => {
      const signal = AbortSignal.any([lifetime.signal, exec.signal]);
      return track(Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal); }));
    };

    const handle = (operation: (request: Request) => Promise<unknown>) => (request: Request): Promise<Response> => {
      if (closing) return Promise.resolve(errorResponse(new VaultError('storage_unavailable', 'Notes routes are closed.')));
      const response = Promise.resolve()
        .then(() => { if (request.signal.aborted) throw new VaultError('storage_unavailable', 'Notes request was cancelled.'); return operation(request); })
        .then(value => Response.json(value, { headers: { 'cache-control': 'no-store' } }))
        .catch(errorResponse);
      return track(response);
    };

    const dispose = (): Promise<void> => {
      if (disposal) return disposal;
      closing = true;
      lifetime.abort(new Error('Notes plugin was unloaded.'));
      disposal = (async () => {
        const removed = await Promise.allSettled([...disposers, ...removals].map(async remove => remove()));
        await Promise.allSettled(pending);
        const failed = removed.filter(result => result.status === 'rejected');
        if (failed.length > 0) {
          throw new AggregateError(failed.map(result => result.reason), 'Notes routes could not be removed.');
        }
      })();
      return disposal;
    };

    try {
      disposers.push(ctx.connection.fetch.register({
        path: NOTES_TREE_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(() => service.tree()),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: NOTES_NOTE_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(request => service.read(new URL(request.url).searchParams.get('id') ?? '')),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: NOTES_SEARCH_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(request => {
          const params = new URL(request.url).searchParams;
          const raw = params.get('limit');
          return service.search(params.get('q') ?? '', raw === null ? undefined : Number(raw));
        }),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: NOTES_TAGS_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(() => service.tags().then(tags => ({ tags }))),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: NOTES_PROPOSALS_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(() => service.pendingProposals().then(proposals => ({ proposals }))),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: NOTES_ANNOTATIONS_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
        fetch: handle(async request => {
          if (request.method === 'GET') {
            const id = new URL(request.url).searchParams.get('id');
            return service.annotationsOf(id === null ? undefined : id);
          }
          const contentType = (request.headers.get('content-type')?.split(';', 1)[0] ?? '').trim().toLowerCase();
          if (contentType !== 'application/json') {
            throw new VaultError('invalid_request', 'Annotation requests require application/json.');
          }
          let value: unknown;
          try { value = await request.json(); }
          catch { throw new VaultError('invalid_request', 'Annotation request JSON is malformed.'); }
          return service.annotate(annotationEnvelopeSchema.parse(value).request);
        }),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: NOTES_BACKLINKS_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(async request => {
          const id = new URL(request.url).searchParams.get('id') ?? '';
          return { id, notes: await service.backlinks(id) };
        }),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: NOTES_REVISION_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(async () => ({ version: await watcher.recompute() })),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: NOTES_COMMAND_PATH, methods: ['POST'], requestBody: 'buffered',
        fetch: handle(async request => {
          const contentType = (request.headers.get('content-type')?.split(';', 1)[0] ?? '').trim().toLowerCase();
          if (contentType !== 'application/json') {
            throw new VaultError('invalid_request', 'Notes commands require application/json.');
          }
          let value: unknown;
          try { value = await request.json(); }
          catch { throw new VaultError('invalid_request', 'Notes command JSON is malformed.'); }
          return service.execute(noteCommandEnvelopeSchema.parse(value).request);
        }),
      }));

      removals.push(ctx.tools.register({
        name: 'notes_query',
        description: `Read the built-in ClawMaster notes vault (${root}). Select one mode: tree lists every note, read returns one note with its revision and link facts, search matches text, backlinks lists notes linking to one note, tags counts tags. Read-only and never needs approval. Pass the revision from read into a later save so a concurrent edit is detected instead of overwritten.`,
        parameters: queryParameters,
        output: {
          schema: queryOutput,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => runTool(exec, async () => runQuery(service, args)),
        presentCall: args => querySchema.safeParse(args).success
          ? { card: 'generic', title: 'Read notes', kind: 'search', rawInput: JSON.stringify(args) } : undefined,
        presentResult: (_args, result) => ({ card: 'generic', title: 'Notes query', content: result.content }),
      }));

      removals.push(ctx.tools.register({
        name: 'notes_propose',
        description: `Draft a change to a note in the built-in ClawMaster notes vault (${root}) without writing it. Use this to show a diff before anything is touched: pass the complete proposed note body and the tool returns the proposal id, the revision it was based on, and the line diff. No note changes, so no approval is needed. Apply it later with notes_write action "apply-proposal" (approval-gated, and refused when the note moved in the meantime) or drop it with "discard-proposal". Read them back with notes_query mode "proposals".`,
        parameters: proposeParameters,
        output: {
          schema: proposeOutput,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => Promise.resolve()
          .then(() => { exec.signal.throwIfAborted(); return proposeSchema.parse(args); })
          .then(parsed => service.propose(parsed.id, parsed.text)),
        presentCall: args => proposeSchema.safeParse(args).success
          ? { card: 'generic', title: 'Propose a note change', kind: 'edit', rawInput: JSON.stringify(args) } : undefined,
        presentResult: (_args, result) => ({ card: 'generic', title: 'Note change proposed', content: result.content }),
      }));

      removals.push(ctx.tools.register({
        name: 'notes_digest',
        description: `Append one work entry to today's note in the built-in ClawMaster notes vault (${root}); this is how finished work becomes notes. Pass what was done plus optional decisions, evidence and next steps, and the entry is composed and appended to the daily note. A project name is linked to its note when one matches. Requires an explicit one-shot DSH approval. Use notes_write instead to edit an existing note rather than record work.`,
        parameters: digestParameters,
        output: {
          schema: digestOutput,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          const entry = digestSchema.parse(args);
          if (exec.agent === undefined) throw new Error('notes_digest requires an owning DSH agent session.');
          const outcome = await ctx.approval.request({
            agent: exec.agent,
            callId: exec.callId,
            toolName: exec.name,
            reason: `Append a work entry to today's note in vault ${root}${entry.project === undefined ? '' : ` (project ${entry.project})`}: ${entry.summary.slice(0, 400)}`,
            signal: exec.signal,
          });
          if (outcome !== 'allowed-once') throw new Error(`approval_${outcome}: Notes digest was not committed.`);
          exec.signal.throwIfAborted();
          return service.digest(entry);
        },
        presentCall: args => digestSchema.safeParse(args).success
          ? { card: 'generic', title: 'Record work in notes', kind: 'edit', rawInput: JSON.stringify(args) } : undefined,
        presentResult: (_args, result) => ({ card: 'generic', title: 'Work recorded in notes', content: result.content }),
      }));

      removals.push(ctx.tools.register({
        name: 'notes_annotate',
        description: `Mark a note in the built-in ClawMaster notes vault (${root}): a comment, a highlight, a to-do or a risk, anchored to a line, to a quoted fragment, or to the note as a whole. Use it to record what the user should look at — marks stay beside the note and never rewrite its text. Record source "ai" (the default) for your own marks and pass the model id as author. Every call requires an explicit one-shot DSH approval. Read marks back with notes_query mode "annotations".`,
        parameters: annotateParameters,
        output: {
          schema: annotateOutput,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => runTool(exec, async () => {
          const parsed = annotateSchema.parse(args);
          if (exec.agent === undefined) throw new Error('notes_annotate requires an owning DSH agent session.');
          let request: AnnotationRequest;
          let reason: string;
          if (parsed.action === 'remove') {
            if (parsed.annotationId === undefined) throw new VaultError('invalid_request', 'notes_annotate action "remove" needs annotationId.');
            request = { action: 'remove', annotationId: parsed.annotationId };
            reason = `Remove annotation ${parsed.annotationId} from vault ${root}`;
          } else {
            if (parsed.id === undefined || parsed.body === undefined || parsed.kind === undefined) {
              throw new VaultError('invalid_request', 'notes_annotate action "add" needs id, body and kind.');
            }
            request = {
              action: 'add',
              annotation: {
                id: parsed.id,
                body: parsed.body,
                kind: parsed.kind,
                ...parsed.source !== undefined ? { source: parsed.source } : {},
                ...parsed.author !== undefined ? { author: parsed.author } : {},
                ...parsed.line !== undefined ? { line: parsed.line } : {},
                ...parsed.quote !== undefined ? { quote: parsed.quote } : {},
              },
            };
            const where = parsed.line === undefined ? '' : ` at line ${parsed.line}`;
            reason = `Mark note ${parsed.id}${where} as ${parsed.kind} in vault ${root}: ${parsed.body.slice(0, 300)}`;
          }
          const outcome = await ctx.approval.request({
            agent: exec.agent,
            callId: exec.callId,
            toolName: exec.name,
            reason,
            signal: exec.signal,
          });
          if (outcome !== 'allowed-once') throw new Error(`approval_${outcome}: The annotation was not written.`);
          exec.signal.throwIfAborted();
          return service.annotate(request);
        }),
        presentCall: args => annotateSchema.safeParse(args).success
          ? { card: 'generic', title: 'Mark a note', kind: 'edit', rawInput: JSON.stringify(args) } : undefined,
        presentResult: (_args, result) => ({ card: 'generic', title: 'Note marked', content: result.content }),
      }));

      removals.push(ctx.tools.register({
        name: 'notes_write',
        description: `Create, replace, append to, rename or delete a note in the built-in ClawMaster notes vault (${root}), and append a dated work entry with the "daily" action. Every call requires an explicit one-shot DSH approval; never assume approval from a previous action. "save" needs the expectedRevision from notes_query and fails on a conflict instead of overwriting, so re-read before retrying. "delete" is not recoverable from this tool. The receipt reports revision and previousRevision for auditing.`,
        parameters: commandParameters,
        output: {
          schema: receiptOutput,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => runTool(exec, async signal => {
          const request = noteCommandEnvelopeSchema.parse(args).request;
          if (exec.agent === undefined) throw new Error('notes_write requires an owning DSH agent session.');
          const parsed = noteCommandSchema.parse(request);
          const outcome = await ctx.approval.request({
            agent: exec.agent,
            callId: exec.callId,
            toolName: exec.name,
            reason: commandSummary(parsed, root),
            signal,
          });
          if (outcome !== 'allowed-once') throw new Error(`approval_${outcome}: Notes change was not committed.`);
          signal.throwIfAborted();
          return service.execute(parsed);
        }),
        presentCall: args => typeof args === 'object' && args !== null && 'request' in args
          ? { card: 'generic', title: 'Change notes', kind: 'edit', rawInput: JSON.stringify(args) } : undefined,
        presentResult: (_args, result) => ({
          card: 'generic',
          title: result.isError ? 'Notes change failed' : 'Notes change committed',
          content: result.content,
        }),
      }));

      // Memory bridge: a note the user already wrote should reach the model without being asked
      // for, so each turn's opening request is matched against the vault's note names. The block
      // is attributed to this plugin and marked a snapshot, so a later turn supersedes it instead
      // of piling up, and no note is named to the same agent twice.
      if (options.notesContext === 'related' && ctx.on !== undefined) {
        const announced = new WeakMap<object, Set<string>>();
        const stop = ctx.on('agent/pre-step', async (payload, next) => {
          const decision = await next();
          if (decision.kind !== 'enter' || payload.step !== 1 || lifetime.signal.aborted) return decision;
          const request = requestTextOf(payload.messages);
          const tokens = request === undefined ? [] : contextTokens(request);
          if (tokens.length === 0) return decision;
          try {
            const seen = announced.get(payload.agent) ?? new Set<string>();
            announced.set(payload.agent, seen);
            const ranked = rankRelated((await service.tree()).notes, tokens, options.maxContextNotes)
              .filter(note => !seen.has(note.id));
            const text = renderRelatedNotes(ranked);
            if (text === '') return decision;
            for (const note of ranked) seen.add(note.id);
            return {
              ...decision,
              messages: [...decision.messages, createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
              })],
            };
          } catch (error) {
            // A vault that cannot be listed must never cost the turn its step.
            ctx.logger?.warn(`clawmaster-notes: related notes were skipped: ${String(error)}`);
            return decision;
          }
        });
        if (typeof stop === 'function') removals.push(stop);
      }

      return async () => {
        try { await dispose(); }
        finally { watcher.close(); }
      };
    } catch (error) {
      watcher.close();
      await dispose();
      throw error;
    }
  }, 'clawmaster: notes routes and tools');
}
