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
import {
  NOTES_BACKLINKS_PATH, NOTES_COMMAND_PATH, NOTES_NOTE_PATH, NOTES_SEARCH_PATH, NOTES_TAGS_PATH, NOTES_TREE_PATH,
  noteCommandEnvelopeSchema, noteCommandSchema, notesFailureSchema,
} from './protocol.ts';
import { DEFAULT_LIMITS, NotesService, commandSummary, type NotesLimits } from './service.ts';
import { VaultError, openVault, type VaultEntry } from './vault.ts';

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
]);

const text = (description: string): Record<string, unknown> => ({ type: 'string', description });
const noteId = text('Vault-relative note path ending in .md, e.g. "项目/ClawMaster.md".');

const queryParameters: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['tree', 'read', 'search', 'backlinks', 'tags'], description: 'Which read to perform.' },
    id: noteId,
    query: text('Case-insensitive substring to search for.'),
    limit: { type: 'integer', description: 'Maximum hits; clamped by the deployment limit.' },
  },
};

const queryOutput: Record<string, unknown> = { type: 'object', additionalProperties: true };

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
        path: NOTES_BACKLINKS_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(async request => {
          const id = new URL(request.url).searchParams.get('id') ?? '';
          return { id, notes: await service.backlinks(id) };
        }),
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

      return dispose;
    } catch (error) {
      await dispose();
      throw error;
    }
  }, 'clawmaster: notes routes and tools');
}
