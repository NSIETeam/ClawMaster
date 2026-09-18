/**
 * Built-in PDF: authenticated Fetch routes plus approval-gated agent tools.
 *
 * The whole built-in track is the editor in `editor.ts` plus the folder policy in `paths.ts`; this
 * module is only the wiring. Two decisions are worth stating:
 *
 * - The folder comes from configuration, not from the model. A tool that took an absolute path could
 *   reach anything the Host process can, and `ToolRunContext` carries no working directory to derive
 *   one from, so the folder is named once in the profile and every path is resolved inside it.
 * - Reading is free and writing is approved. Inspecting a document, listing what the tools can do, and
 *   asking the optional component what it supports change nothing; an edit writes files, so it asks for
 *   one explicit grant per call.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readFile, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type ApprovalService from '@deepseek-ai/dsh-user-approval';
import {
  PDF_EDIT_PATH, PDF_INFO_PATH, PDF_STIRLING_PATH, DELEGATED_OPERATIONS,
  pdfCommandEnvelope, pdfEditRequestSchema, pdfFailureSchema, pdfInfoSchema, pdfEditReceiptSchema, stirlingStatusSchema,
  type PdfEditRequest, type StirlingStatus,
} from './protocol.ts';
import { PdfService, PdfServiceError, type PdfFs } from './service.ts';

export const name = 'clawmaster-pdf';
export const inject = ['connection', 'tools', 'approval'];

/** One route on DSH's authenticated Fetch carrier, which owns authentication and origin checks. */
export interface PdfFetchRegistry {
  register(route: {
    path: string;
    methods: readonly ('GET' | 'POST')[];
    requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void>;
}

/** The execution context supplied by the DSH tool registry. */
export type PdfToolRun = ToolRunContext;

/** The tool definition accepted by the DSH registry. */
export type PdfToolDefinition = ToolDefinition;

/** The public DSH services this plugin consumes. */
export interface PdfHostContext {
  connection: { fetch: PdfFetchRegistry };
  tools: Pick<ToolRuntime, 'register'>;
  approval: Pick<ApprovalService, 'request'>;
  effect: Context['effect'];
  /** Publish the service handle companion plugins read with `get`. Optional. */
  provide?(name: string, value: unknown): void;
  get?(name: string): unknown;
  logger?: { warn(message: string): void };
}

const configSchema = z.object({
  /** The folder every PDF path is resolved inside. Absolute, because a relative one would move with the process. */
  root: z.string().min(1).optional(),
  /** Where the optional Stirling-PDF runtime lives, when it is installed. */
  stirlingDirectory: z.string().min(1).optional(),
  /** Whether the optional heavy track is enabled in settings. */
  stirlingEnabled: z.boolean().default(false),
});
export type PdfHostConfig = z.input<typeof configSchema>;

/** The context key the PDF plugin publishes its service under. */
export const PDF_ACCESS_KEY = 'clawmasterPdf';

/** The folder the tools work in when the profile does not name one. */
export function defaultRoot(home = homedir()): string {
  return join(home, 'Documents');
}

/** The component's own data directory, holding the optional runtime rather than documents. */
export function defaultStirlingDirectory(home = homedir()): string {
  return join(home, '.clawmaster', 'components', 'pdf', 'runtime');
}

/** The filesystem surface the service writes through. */
const storeFs: PdfFs = {
  readFile: path => readFile(path),
  writeFile: (path, data) => writeFile(path, data),
  mkdir: (path, options) => mkdir(path, options),
  rename: (from, to) => rename(from, to),
  stat: async path => { const info = await stat(path); return { size: info.size, mtimeMs: info.mtimeMs }; },
  unlink: path => unlink(path),
};

/**
 * Register the PDF routes and tools for the plugin lifetime.
 * @param ctx - DSH Fetch, tool and approval services.
 * @param config - The folder the tools work in, plus the optional runtime location.
 */
export async function apply(ctx: PdfHostContext, config: PdfHostConfig = {}): Promise<void> {
  const options = configSchema.parse(config);
  const root = options.root ?? defaultRoot();
  if (!isAbsolute(root)) throw new Error('The PDF folder must be an absolute path.');
  const stirlingDirectory = options.stirlingDirectory ?? defaultStirlingDirectory();
  if (!isAbsolute(stirlingDirectory)) throw new Error('The Stirling-PDF directory must be an absolute path.');
  await ctx.effect(async () => {
    const stirling = await probeStirling(stirlingDirectory, options.stirlingEnabled);
    const service = new PdfService({ root, fs: storeFs, stirling });
    ctx.provide?.(PDF_ACCESS_KEY, service);
    const removals: Array<() => void> = [];
    const disposers: Array<() => Promise<void>> = [];
    const pending = new Set<Promise<unknown>>();
    let closing = false;

    const track = <T,>(operation: Promise<T>): Promise<T> => {
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    };
    const handle = (operation: (request: Request) => Promise<unknown>) => (request: Request): Promise<Response> => {
      if (closing) return Promise.resolve(failure(new PdfServiceError('storage_unavailable', 'PDF routes are closed.')));
      const response = Promise.resolve()
        .then(() => operation(request))
        .then(value => Response.json(value, { headers: { 'cache-control': 'no-store' } }))
        .catch(error => failure(error));
      return track(response);
    };
    const json = async (request: Request): Promise<unknown> => {
      const contentType = (request.headers.get('content-type')?.split(';', 1)[0] ?? '').trim().toLowerCase();
      if (contentType !== 'application/json') throw new PdfServiceError('invalid_request', 'PDF commands require application/json.');
      try {
        return await request.json();
      } catch {
        throw new PdfServiceError('invalid_request', 'PDF command JSON is malformed.');
      }
    };

    try {
      disposers.push(ctx.connection.fetch.register({
        path: PDF_INFO_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(async request => {
          const source = new URL(request.url).searchParams.get('path');
          if (source === null || source === '') throw new PdfServiceError('invalid_request', 'A path is required.');
          return service.info(source);
        }),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: PDF_EDIT_PATH, methods: ['POST'], requestBody: 'buffered',
        fetch: handle(async request => {
          const parsed = pdfCommandEnvelope(pdfEditRequestSchema).parse(await json(request));
          return service.edit(parsed.request as PdfEditRequest);
        }),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: PDF_STIRLING_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(() => Promise.resolve(service.stirling())),
      }));

      removals.push(ctx.tools.register({
        name: 'pdf_info',
        description: `Read a PDF's structure inside the configured folder (${root}). Returns the page count, each page's size and rotation, and the document metadata, together with the revision a later write would report. Read-only and never needs approval.`,
        parameters: {
          type: 'object', additionalProperties: false, required: ['path'],
          properties: { path: { type: 'string', description: 'Path relative to the configured folder, ending in .pdf.' } },
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => runTool(exec, async () => {
          const parsed = z.object({ path: z.string().min(1).max(1024) }).strict().parse(args);
          return { ...await service.info(parsed.path) } satisfies z.output<typeof pdfInfoSchema>;
        }),
        presentCall: args => args !== null && typeof args === 'object' && 'path' in args
          ? { card: 'generic', title: 'Inspect a PDF', kind: 'search', rawInput: JSON.stringify(args) } : undefined,
        presentResult: (_args, result) => ({ card: 'generic', title: 'PDF structure', content: result.content }),
      }));

      removals.push(ctx.tools.register({
        name: 'pdf_edit',
        description: `Apply PDF operations inside the configured folder (${root}) and write the results. Operations: extract (mode keep splits the named pages into their own files, mode remove deletes them), reorder, rotate, delete, merge, insert, pageNumbers, watermark, metadata. Page selections are written the way a person writes them: 1, 3-5, last, -2--1, all. The source file is never overwritten unless inPlace is true, and a split never touches it at all. The built-in tools draw Latin text only and cannot encrypt, decrypt, OCR, fill forms, sign, extract text or convert formats — those need the optional Stirling-PDF component. Writing files requires an explicit one-shot DSH approval.`,
        parameters: {
          type: 'object', additionalProperties: false, required: ['source', 'operations'],
          properties: {
            source: { type: 'string', description: 'The file to work on, relative to the configured folder.' },
            inputs: { type: 'array', items: { type: 'string' }, description: 'Other files the operations name, in the same folder.' },
            operations: {
              type: 'array',
              description: 'Operations, applied in order.',
              items: {
                type: 'object',
                properties: {
                  op: { type: 'string', enum: ['extract', 'reorder', 'rotate', 'delete', 'merge', 'insert', 'pageNumbers', 'watermark', 'metadata'] },
                  ranges: { type: 'string', description: 'For extract: the pages to keep or remove.' },
                  mode: { type: 'string', enum: ['keep', 'remove'] },
                  order: { type: 'string', description: 'For reorder: every page exactly once, in the new order.' },
                  pages: { type: 'string', description: 'For rotate and delete: the pages to affect.' },
                  by: { type: 'number', description: 'For rotate: 90, 180 or 270.' },
                  paths: { type: 'array', items: { type: 'string' }, description: 'For merge: the files to append.' },
                  at: { type: 'number', description: 'For insert: the page position to insert at.' },
                  from: { type: 'string', description: 'For insert: the file to insert.' },
                  text: { type: 'string', description: 'For watermark: the text to draw, Latin only.' },
                  opacity: { type: 'number' }, size: { type: 'number' }, angle: { type: 'number' },
                  color: { type: 'string', enum: ['red', 'grey', 'blue'] },
                  position: { type: 'string', enum: ['bottom-center', 'bottom-right', 'top-center', 'top-right'] },
                  startAt: { type: 'number' }, template: { type: 'string' },
                  title: { type: 'string' }, author: { type: 'string' }, subject: { type: 'string' },
                  keywords: { type: 'array', items: { type: 'string' } },
                },
                required: ['op'],
              },
            },
            inPlace: { type: 'boolean', description: 'Replace the source when the sequence produces a single file.' },
          },
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => runTool(exec, async signal => {
          const request = pdfEditRequestSchema.parse(args) as PdfEditRequest;
          if (exec.agent === undefined) throw new PdfServiceError('invalid_request', 'pdf_edit requires an owning DSH agent session.');
          const target = request.inPlace
            ? `replacing ${request.source}`
            : `writing ${request.operations.length} operation(s) beside ${request.source}`;
          const outcome = await ctx.approval.request({
            agent: exec.agent,
            callId: exec.callId,
            toolName: exec.name,
            reason: `Write PDF files in ${root}: ${target}.`,
            signal,
          });
          if (outcome !== 'allowed-once') throw new PdfServiceError('conflict', `approval_${outcome}: the PDF was not changed.`);
          signal.throwIfAborted();
          return { ...await service.edit(request) } satisfies z.output<typeof pdfEditReceiptSchema>;
        }),
        presentCall: args => args !== null && typeof args === 'object' && 'source' in args
          ? { card: 'generic', title: 'Edit a PDF', kind: 'edit', rawInput: JSON.stringify(args) } : undefined,
        presentResult: (_args, result) => ({ card: 'generic', title: 'PDF written', content: result.content }),
      }));

      removals.push(ctx.tools.register({
        name: 'pdf_stirling',
        description: `Report whether the optional Stirling-PDF component is available in ClawMaster (${stirlingDirectory}) and which operations the built-in tools deliberately leave to it: ${DELEGATED_OPERATIONS.join(', ')}. Read-only and never needs approval. Use it before telling the user a PDF cannot be handled.`,
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (_args, exec) => runTool(exec, async () => ({ ...await probeStirling(stirlingDirectory, options.stirlingEnabled) }) satisfies z.output<typeof stirlingStatusSchema>),
      }));

      return async () => {
        try {
          closing = true;
          await Promise.allSettled(pending);
          await Promise.allSettled([...disposers, ...removals].map(async remove => remove()));
        } finally {
          void service;
        }
      };
    } catch (error) {
      throw error;
    }
  }, 'clawmaster: pdf routes and tools');
}

/**
 * Look at the optional runtime directory.
 *
 * The probe is deliberately shallow: it reports what is on disk and never starts anything, because the
 * heavy track must not cost anything to a user who never enables it.
 * @param directory - Where the optional runtime would live.
 * @param enabled - Whether settings turned the track on.
 * @returns The status the panel and the tool both report.
 */
export async function probeStirling(directory: string, enabled: boolean): Promise<StirlingStatus> {
  const base: StirlingStatus = { available: false, directory, delegatedOperations: [...DELEGATED_OPERATIONS] };
  if (!enabled) return { ...base, reason: 'The optional Stirling-PDF component is not enabled in component settings.' };
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) return { ...base, reason: `${directory} is not a directory.` };
  } catch {
    return { ...base, reason: `The optional runtime is not installed at ${directory}.` };
  }
  return {
    ...base,
    available: true,
    reason: 'The optional runtime is installed; starting it is a separate step and is not done by this report.',
  };
}

/** Run a tool body with the caller's cancellation honoured. */
function runTool(exec: ToolRunContext, action: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  return Promise.resolve().then(() => {
    exec.signal?.throwIfAborted();
    return action(exec.signal ?? new AbortController().signal);
  });
}

/** A refusal in the shape every route answers with. */
function failure(error: unknown): Response {
  const known = error instanceof PdfServiceError
    ? error
    : new PdfServiceError('invalid_request', error instanceof Error ? error.message : String(error));
  const status = known.code === 'not_found' ? 404 : known.code === 'conflict' ? 409 : known.code === 'unsupported' ? 422 : 400;
  const body = pdfFailureSchema.parse({ error: { code: known.code, message: known.message } });
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
