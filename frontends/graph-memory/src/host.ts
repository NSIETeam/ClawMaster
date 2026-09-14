/** Built-in Graph Memory routes and model tools over the DSH storage service. */
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { Storage } from '@deepseek-ai/dsh-storage';
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { GraphMemoryEngine, panelProjection } from './engine.ts';
import { GraphStore } from './store.ts';
import { planWriteback, tokenize } from './algorithms.ts';
import { indexSources, type GraphIndexConfig, type NotesAccess } from './indexer.ts';
import {
  GRAPH_MEMORY_GRAPH_PATH, GRAPH_MEMORY_QUERY_PATH, GRAPH_MEMORY_REFRESH_PATH,
  graphPanelSchema, graphQueryResultSchema, graphQuerySchema, graphRefreshSchema,
  graphWritebackPlanResultSchema, graphWritebackPlanSchema,
} from './protocol.ts';

export const name = 'clawmaster-graph-memory';
export const inject = ['connection', 'tools', 'storage', 'storage.backend.sqlite', 'clawmasterNotes'];
export const GRAPH_MEMORY_ACCESS_KEY = 'clawmaster.graph-memory.access';

/** Authenticated Fetch carrier used by the desktop Host. */
export interface GraphFetchRegistry {
  register(route: {
    path: string;
    methods: readonly ('GET' | 'POST')[];
    requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void>;
}

/** Host services consumed by Graph Memory. */
export interface GraphMemoryHostContext {
  connection: { fetch: GraphFetchRegistry };
  tools: Pick<ToolRuntime, 'register'>;
  storage: Storage;
  effect: Context['effect'];
  get?(name: string): unknown;
  on?(event: 'agent/pre-step', listener: GraphStepListener): (() => void) | void;
  logger?: { warn(message: string): void };
  provide?(name: string, value: unknown): void;
}

interface GraphStepMessage {
  content: unknown;
  source?: { kind?: string };
}

interface GraphStepPayload { agent: object; step: number; messages: readonly GraphStepMessage[] }
type GraphStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: readonly GraphStepMessage[] };
type GraphStepListener = (payload: GraphStepPayload, next: () => Promise<GraphStepDecision>) => Promise<GraphStepDecision>;

const configSchema = z.object({
  storageBackend: z.string().regex(/^[a-z][a-z0-9_]*$/).default('sqlite'),
  memory: z.enum(['auto', 'off']).default('auto'),
  includePeerMemory: z.boolean().default(false),
  maxMemoryEntries: z.number().int().min(1).max(2000).default(500),
  similarityThreshold: z.number().min(0).max(1).default(0.18),
  similarPerDocument: z.number().int().min(1).max(20).default(3),
  maxContextItems: z.number().int().min(1).max(10).default(6),
  refreshOnTurn: z.boolean().default(true),
  fileSources: z.array(z.object({ label: z.string().trim().min(1), path: z.string().startsWith('/') }).strict()).default([]),
}).strict();

export type GraphMemoryHostConfig = z.input<typeof configSchema>;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...value } = z.toJSONSchema(schema);
  return value;
}

const queryParameters = jsonSchema(graphQuerySchema) as ToolDefinition['parameters'];
const refreshParameters = jsonSchema(graphRefreshSchema) as ToolDefinition['parameters'];
const queryOutput = jsonSchema(graphQueryResultSchema) as ToolDefinition['output']['schema'];
const writebackParameters = jsonSchema(graphWritebackPlanSchema) as ToolDefinition['parameters'];
const writebackOutput = jsonSchema(graphWritebackPlanResultSchema) as ToolDefinition['output']['schema'];

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(block => typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'
    ? [(block as { text: string }).text] : []).join('\n').trim();
  return text || undefined;
}

function requestText(messages: readonly GraphStepMessage[]): string | undefined {
  const message = [...messages].reverse().find(candidate => candidate.source?.kind === 'user');
  return message === undefined ? undefined : textOf(message.content);
}

function contextMessage(text: string): GraphStepMessage {
  return {
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
  } as GraphStepMessage;
}

function excerptOf(text: string, query: string, limit = 900): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLocaleLowerCase();
  const position = tokenize(query).map(term => lower.indexOf(term)).filter(index => index >= 0).sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, position - Math.floor(limit / 3));
  const excerpt = normalized.slice(start, start + limit);
  return `${start > 0 ? '…' : ''}${excerpt}${start + limit < normalized.length ? '…' : ''}`;
}

function queryFromUrl(request: Request): z.input<typeof graphQuerySchema> {
  const params = new URL(request.url).searchParams;
  const query = params.get('q') ?? undefined;
  const file = params.get('file') ?? undefined;
  const limit = params.get('limit');
  const hops = params.get('hops');
  return {
    ...(query === undefined ? {} : { query }),
    ...(file === undefined ? {} : { file }),
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(hops === null ? {} : { hops: Number(hops) }),
  };
}

async function jsonBody(request: Request): Promise<unknown> {
  const contentType = (request.headers.get('content-type')?.split(';', 1)[0] ?? '').trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('Graph Memory requests require application/json.');
  return request.json();
}

function errorResponse(error: unknown): Response {
  const invalid = error instanceof z.ZodError;
  return Response.json({ error: { code: invalid ? 'invalid_request' : 'graph_unavailable', message: invalid ? 'Graph Memory request fields are invalid.' : String(error) } }, {
    status: invalid ? 400 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}

/** Register routes and tools for the storage unit's lifetime. */
export async function apply(ctx: GraphMemoryHostContext, config: GraphMemoryHostConfig = {}): Promise<void> {
  const options = configSchema.parse(config);
  await ctx.effect(async () => {
    const lifetime = new AbortController();
    const engine = new GraphMemoryEngine(await GraphStore.open(ctx.storage, options.storageBackend));
    const notes = ctx.get?.('clawmasterNotes') as NotesAccess | undefined;
    if (notes === undefined) throw new Error('Graph Memory requires the ClawMaster Notes access service.');
    const indexConfig: GraphIndexConfig = options;
    const refresh = async (signal?: AbortSignal) => engine.replace(await indexSources(notes, indexConfig, signal));
    const ensureIndex = async (signal?: AbortSignal) => (await engine.graph()).generatedAt === '' ? refresh(signal) : engine.graph();
    ctx.provide?.(GRAPH_MEMORY_ACCESS_KEY, engine);
    const removals: Array<() => void | Promise<void>> = [];
    const handle = (operation: (request: Request) => Promise<unknown>) => async (request: Request): Promise<Response> => {
      try {
        request.signal.throwIfAborted();
        return Response.json(await operation(request), { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return errorResponse(error);
      }
    };
    try {
      removals.push(ctx.connection.fetch.register({
        path: GRAPH_MEMORY_GRAPH_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(async request => graphPanelSchema.parse(panelProjection(await ensureIndex(request.signal)))),
      }));
      removals.push(ctx.connection.fetch.register({
        path: GRAPH_MEMORY_QUERY_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
        fetch: handle(async request => {
          await ensureIndex(request.signal);
          return engine.query(graphQuerySchema.parse(request.method === 'GET' ? queryFromUrl(request) : await jsonBody(request)));
        }),
      }));
      removals.push(ctx.connection.fetch.register({
        path: GRAPH_MEMORY_REFRESH_PATH, methods: ['POST'], requestBody: 'buffered',
        fetch: handle(async request => {
          const parsed = graphRefreshSchema.parse(await jsonBody(request));
          if (parsed.semantic) throw new Error('Semantic refresh is read-only but is not enabled in this build.');
          return refresh(request.signal);
        }),
      }));

      removals.push(ctx.tools.register({
        name: 'graph_memory_query',
        description: 'Search ClawMaster notes and agent memory as one graph. Returns ranked documents and the matched terms or graph edges that justify every result.',
        parameters: queryParameters,
        output: {
          schema: queryOutput,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        isConcurrencySafe: args => graphQuerySchema.safeParse(args).success,
        execute: async (args, exec) => {
          exec.signal.throwIfAborted();
          await ensureIndex(exec.signal);
          return engine.query(graphQuerySchema.parse(args));
        },
        presentCall: args => ({ card: 'generic', title: 'Search notes and memory', kind: 'search', rawInput: JSON.stringify(args) }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'Graph Memory results', content: result.content }),
      }));

      removals.push(ctx.tools.register({
        name: 'graph_memory_refresh',
        description: 'Refresh the derived ClawMaster notes-and-memory graph in process. This reads OpenViking when configured and never writes agent memory.',
        parameters: refreshParameters,
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
          const parsed = graphRefreshSchema.parse(args);
          exec.signal.throwIfAborted();
          if (parsed.semantic) throw new Error('Semantic refresh is read-only but is not enabled in this build.');
          return refresh(exec.signal);
        },
        presentCall: () => ({ card: 'generic', title: 'Refresh Graph Memory', kind: 'edit' }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'Graph Memory refresh', content: result.content }),
      }));

      removals.push(ctx.tools.register({
        name: 'graph_memory_plan_writeback',
        description: 'Preview how durable facts split between notes and memory, including the reciprocal wiki links. This tool never writes either system.',
        parameters: writebackParameters,
        output: { schema: writebackOutput, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        isConcurrencySafe: args => graphWritebackPlanSchema.safeParse(args).success,
        execute: async (args, exec) => {
          exec.signal.throwIfAborted();
          const parsed = graphWritebackPlanSchema.parse(args);
          return planWriteback(parsed.items, parsed.noteTitle, parsed.memoryTitle);
        },
        presentCall: args => ({ card: 'generic', title: 'Plan notes and memory writeback', kind: 'search', rawInput: JSON.stringify(args) }),
        presentResult: (_args, result) => ({ card: 'generic', title: 'Writeback plan', content: result.content }),
      }));

      if (ctx.on !== undefined) {
        const stop = ctx.on('agent/pre-step', async (payload, next) => {
          const decision = await next();
          if (decision.kind !== 'enter' || payload.step !== 1 || lifetime.signal.aborted) return decision;
          const query = requestText(payload.messages);
          if (query === undefined) return decision;
          try {
            if (options.refreshOnTurn) await refresh(lifetime.signal);
            else await ensureIndex(lifetime.signal);
            const result = await engine.query({ query, limit: options.maxContextItems, hops: 1 });
            const graph = await engine.graph();
            const byId = new Map(graph.nodes.map(node => [node.id, node]));
            const rows: string[] = [];
            for (const hit of [...result.hits, ...result.related].slice(0, options.maxContextItems)) {
              const node = byId.get(hit.id);
              if (node === undefined) continue;
              let excerpt = '';
              if (node.kind === 'note' && node.path !== null) excerpt = excerptOf((await notes.read(node.path)).text, query);
              else if (node.kind === 'memory') excerpt = excerptOf(String(node.meta['content'] ?? ''), query);
              rows.push(`- [${node.kind === 'note' ? '笔记' : '记忆'}] ${node.title} (${node.path ?? node.id})\n  依据：${hit.why}${hit.via === undefined ? '' : `；${hit.via}`}\n  摘要：${excerpt}`);
            }
            if (rows.length === 0) return decision;
            const text = `Graph Memory 统一召回（笔记与记忆使用同一评分，不写回）：\n${rows.join('\n')}`;
            return { ...decision, messages: [...decision.messages, contextMessage(text)] };
          } catch (error) {
            ctx.logger?.warn(`clawmaster-graph-memory: unified context was skipped: ${String(error)}`);
            return decision;
          }
        });
        if (typeof stop === 'function') removals.push(stop);
      }
      return async () => {
        lifetime.abort();
        const settled = await Promise.allSettled(removals.reverse().map(async remove => remove()));
        await engine.close();
        const failures = settled.filter(result => result.status === 'rejected');
        if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Graph Memory registrations could not be removed.');
      };
    } catch (error) {
      lifetime.abort();
      await Promise.allSettled(removals.reverse().map(async remove => remove()));
      await engine.close();
      throw error;
    }
  }, 'clawmaster: graph memory routes and tools');
}
