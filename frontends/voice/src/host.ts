/**
 * Built-in Voice: authenticated Fetch routes plus approval-gated agent tools.
 *
 * The panel does the audio work (device capture, resampling, endpointing) and posts one segment at a
 * time; the Host owns recognition, speaker attribution and the durable timeline. That split keeps the
 * model inside the Host where it can be loaded once, and keeps every byte of audio off the disk.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type ApprovalService from '@deepseek-ai/dsh-user-approval';
import {
  VOICE_AUDIO_PATH, VOICE_MODELS_PATH, VOICE_SESSION_PATH, VOICE_SPEAKERS_PATH, VOICE_STATE_PATH,
  audioPostEnvelopeSchema, speakerCommandEnvelopeSchema, sessionCommandEnvelopeSchema,
  type VoiceModels,
} from './protocol.ts';
import { VoiceError, VoiceService, defaultTitle } from './service.ts';
import { writeUp, type NotesWriter } from './notes-bridge.ts';
import type { StoreFs } from './store.ts';
import { VOICE_ACCESS_KEY, createVoiceAccess } from './access.ts';

export const name = 'clawmaster-voice';
export const inject = ['connection', 'tools', 'approval'];

/**
 * The context key the notes plugin publishes its vault access under.
 * Voice only ever appends a daily entry and writes its own meeting note through this handle, so the
 * vault keeps one writer.
 */
export const NOTES_ACCESS_KEY = 'clawmasterNotes';

/** One route on DSH's authenticated Fetch carrier, which owns authentication and origin checks. */
export interface VoiceFetchRegistry {
  register(route: {
    path: string;
    methods: readonly ('GET' | 'POST')[];
    requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void>;
}

/** The execution context supplied by the DSH tool registry. */
export type VoiceToolRun = ToolRunContext;

/** The tool definition accepted by the DSH registry. */
export type VoiceToolDefinition = ToolDefinition;

/** The public DSH services this plugin consumes. */
export interface VoiceHostContext {
  connection: { fetch: VoiceFetchRegistry };
  tools: Pick<ToolRuntime, 'register'>;
  approval: Pick<ApprovalService, 'request'>;
  effect: Context['effect'];
  /** Publish the live-session handle companion plugins read with `get`. Optional. */
  provide?(name: string, value: unknown): void;
  get?(name: string): unknown;
  logger?: { warn(message: string): void };
}

const configSchema = z.object({
  /** Absolute vault root whose `.clawmaster/voice` holds the timelines. */
  vaultRoot: z.string().min(1).optional(),
  /** Where the models and the enrolled voiceprints live. */
  dataRoot: z.string().min(1).optional(),
  /** Model directory override. */
  modelDirectory: z.string().min(1).optional(),
  /** Threads the native engine may use; speech recognition is CPU-bound, so this stays low. */
  threads: z.number().int().min(1).max(8).default(2),
  /** Whisper language hint, 'auto' to detect per segment. */
  language: z.string().min(2).max(8).default('auto'),
});
export type VoiceHostConfig = z.input<typeof configSchema>;

/** The vault the component writes into when the profile does not name one. */
export function defaultVaultRoot(home = homedir()): string {
  return process.platform === 'darwin'
    ? join(home, 'Documents', 'ClawMaster 笔记')
    : join(home, 'ClawMasterNotes');
}

/** The component's own data directory, holding models and voiceprints rather than notes. */
export function defaultDataRoot(home = homedir()): string {
  return join(home, '.clawmaster', 'components', 'voice');
}

/** The filesystem surface the timeline store writes through. */
const storeFs: StoreFs = { mkdir, appendFile, readFile, rename, writeFile };

/**
 * Register the Voice routes and tools for the plugin lifetime.
 * @param ctx - DSH Fetch, tool and approval services.
 * @param config - Optional vault and data roots, thread count and language.
 */
export async function apply(ctx: VoiceHostContext, config: VoiceHostConfig = {}): Promise<void> {
  const options = configSchema.parse(config);
  const vaultRoot = options.vaultRoot ?? defaultVaultRoot();
  const dataRoot = options.dataRoot ?? defaultDataRoot();
  if (!isAbsolute(vaultRoot)) throw new Error('Voice vault root must be an absolute path.');
  if (!isAbsolute(dataRoot)) throw new Error('Voice data root must be an absolute path.');
  await ctx.effect(async () => {
    const service = new VoiceService({
      vaultRoot,
      dataRoot,
      ...(options.modelDirectory === undefined ? {} : { modelDirectory: options.modelDirectory }),
      threads: options.threads,
      language: options.language,
      fs: storeFs,
      now: () => Date.now(),
    });
    await service.open();
    ctx.provide?.(VOICE_ACCESS_KEY, createVoiceAccess(service, vaultRoot));
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
      if (closing) return Promise.resolve(failure(new VoiceError('storage_unavailable', 'Voice routes are closed.')));
      const response = Promise.resolve()
        .then(() => operation(request))
        .then(value => json(value))
        .catch(error => failure(error));
      return track(response);
    };
    const body = async (request: Request): Promise<unknown> => {
      const contentType = (request.headers.get('content-type')?.split(';', 1)[0] ?? '').trim().toLowerCase();
      if (contentType !== 'application/json') throw new VoiceError('invalid_request', 'Voice commands require application/json.');
      try {
        return await request.json();
      } catch {
        throw new VoiceError('invalid_request', 'Voice command JSON is malformed.');
      }
    };

    try {
      disposers.push(ctx.connection.fetch.register({
        path: VOICE_STATE_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(async request => {
          const sessionId = new URL(request.url).searchParams.get('sessionId');
          if (sessionId === null) return service.state() ?? null;
          return await service.readSession(sessionId) ?? null;
        }),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: VOICE_SESSION_PATH, methods: ['POST'], requestBody: 'buffered',
        fetch: handle(async request => {
          const command = sessionCommandEnvelopeSchema.parse(await body(request)).request;
          return command.action === 'start'
            ? service.start(command.title, command.project)
            : service.stop();
        }),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: VOICE_AUDIO_PATH, methods: ['POST'], requestBody: 'buffered',
        fetch: handle(async request => {
          const post = audioPostEnvelopeSchema.parse(await body(request)).request;
          return service.ingest(post);
        }),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: VOICE_SPEAKERS_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
        fetch: handle(async request => {
          if (request.method === 'GET') {
            return { enrolled: service.enrolledNames(), state: service.state() ?? null };
          }
          const command = speakerCommandEnvelopeSchema.parse(await body(request)).request;
          return service.runSpeakerCommand(command);
        }),
      }));
      disposers.push(ctx.connection.fetch.register({
        path: VOICE_MODELS_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: handle(() => Promise.resolve<unknown>(service.models())),
      }));

      removals.push(ctx.tools.register({
        name: 'voice_state',
        description: `Read the ClawMaster Voice component (${vaultRoot}). Select one mode: live returns the meeting being recorded right now with its speakers and recognized turns, models reports whether the offline speech engine and its model files are ready, session reads a finished recording by id. Read-only and never needs approval. Use it before writing a meeting up, so the note is derived from the recorded timeline instead of from memory.`,
        parameters: {
          type: 'object', additionalProperties: false, required: ['mode'],
          properties: {
            mode: { type: 'string', enum: ['live', 'models', 'session'] },
            sessionId: { type: 'string', description: 'Session id, required for mode "session".' },
          },
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => runTool(exec, async () => {
          const parsed = z.object({ mode: z.enum(['live', 'models', 'session']), sessionId: z.string().optional() }).strict().parse(args);
          if (parsed.mode === 'models') {
            const models: VoiceModels = service.models();
            return { ...models };
          }
          if (parsed.mode === 'session') {
            if (parsed.sessionId === undefined) throw new VoiceError('invalid_request', 'mode "session" requires a sessionId.');
            const index = await service.readSession(parsed.sessionId);
            if (index === undefined) throw new VoiceError('unknown_session', `No recording ${parsed.sessionId}.`);
            return index;
          }
          return service.state() ?? null;
        }),
      }));

      removals.push(ctx.tools.register({
        name: 'voice_transcribe',
        description: `Transcribe one audio segment of the live ClawMaster Voice meeting (${vaultRoot}) and attribute it to a speaker. Audio must be a base64 16 kHz mono 16-bit PCM WAV file; the panel already endpoints segments, so pass one utterance per call. Pass channel when the recording is per-participant, or speakerHint with a speaker id from voice_state to override the automatic attribution. This writes to the recording timeline, so it requires an explicit one-shot DSH approval.`,
        parameters: {
          type: 'object', additionalProperties: false, required: ['wav'],
          properties: {
            wav: { type: 'string', description: 'Base64 16 kHz mono 16-bit PCM WAV.' },
            startMs: { type: 'number', description: 'Milliseconds since the session started.' },
            endMs: { type: 'number', description: 'Milliseconds since the session started.' },
            channel: { type: 'string', description: 'Per-participant channel label, when known.' },
            speakerHint: { type: 'string', description: 'A speaker id from voice_state to force the attribution.' },
          },
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => runTool(exec, async () => {
          const parsed = z.object({
            wav: z.string().min(1),
            startMs: z.number().nonnegative().default(0),
            endMs: z.number().nonnegative().default(0),
            channel: z.string().optional(),
            speakerHint: z.string().optional(),
          }).strict().parse(args);
          const state = service.state();
          if (state === null || state === undefined) throw new VoiceError('no_session', 'No recording session is running.');
          return service.ingest({ sessionId: state.sessionId, ...parsed });
        }),
      }));

      removals.push(ctx.tools.register({
        name: 'voice_writeup',
        description: `Turn a recorded meeting in the ClawMaster Voice component (${vaultRoot}) into a note in the built-in notes vault. The note is composed from the recording's own timeline — every turn with its speaker and timecode — so renaming a speaker and calling this again corrects the note instead of editing it. It also appends one line to the day's journal that links to the note. Pass the session id, a one or two sentence summary, and any decisions and next steps the meeting reached; pass participants when the labels differ from who actually attended. Writes to the notes vault, so it requires an explicit one-shot DSH approval.`,
        parameters: {
          type: 'object', additionalProperties: false, required: ['sessionId', 'summary'],
          properties: {
            sessionId: { type: 'string', description: 'The recording to write up, from voice_state.' },
            summary: { type: 'string', description: 'One or two sentences saying what the meeting was.' },
            decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions the meeting reached.' },
            nextSteps: { type: 'array', items: { type: 'string' }, description: 'What happens next.' },
            participants: { type: 'array', items: { type: 'string' }, description: 'Who attended, when it differs from the labels discovered.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' }, revision: { type: 'string' }, journalId: { type: 'string' },
              journalRevision: { type: 'string' }, replaced: { type: 'boolean' }, keptHumanEdit: { type: 'boolean' }, root: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => runTool(exec, async signal => {
          const parsed = z.object({
            sessionId: z.string().min(1),
            summary: z.string().min(1).max(2000),
            decisions: z.array(z.string().max(500)).max(50).optional(),
            nextSteps: z.array(z.string().max(500)).max(50).optional(),
            participants: z.array(z.string().max(120)).max(50).optional(),
          }).strict().parse(args);
          const notes = ctx.get?.(NOTES_ACCESS_KEY) as NotesWriter | undefined;
          if (notes === undefined) {
            throw new VoiceError('storage_unavailable', 'The notes component is not loaded, so there is nowhere to write the meeting up.');
          }
          const index = await service.readSession(parsed.sessionId);
          if (index === undefined) throw new VoiceError('unknown_session', `No recording ${parsed.sessionId}.`);
          if (exec.agent === undefined) throw new VoiceError('no_session', 'voice_writeup requires an owning DSH agent session.');
          const outcome = await ctx.approval.request({
            agent: exec.agent,
            callId: exec.callId,
            toolName: exec.name,
            reason: `Write the recording "${index.title}" (${index.utterances.length} turns) into the notes vault at ${notes.root} and link it from the day's journal.`,
            signal,
          });
          if (outcome !== 'allowed-once') throw new VoiceError('conflict', `approval_${outcome}: the meeting was not written up.`);
          signal.throwIfAborted();
          return await writeUp(notes, {
            session: index,
            summary: parsed.summary,
            ...(parsed.decisions === undefined ? {} : { decisions: parsed.decisions }),
            ...(parsed.nextSteps === undefined ? {} : { nextSteps: parsed.nextSteps }),
            ...(parsed.participants === undefined ? {} : { participants: parsed.participants }),
          });
        }),
        presentCall: args => args !== null && typeof args === 'object' && 'sessionId' in args
          ? { card: 'generic', title: 'Write the meeting into notes', kind: 'edit', rawInput: JSON.stringify(args) } : undefined,
        presentResult: (_args, result) => ({ card: 'generic', title: 'Meeting note written', content: result.content }),
      }));

      return async () => {
        try {
          closing = true;
          await Promise.allSettled(pending);
          await Promise.allSettled([...disposers, ...removals].map(async remove => remove()));
        } finally {
          service.close();
        }
      };
    } catch (error) {
      service.close();
      throw error;
    }
  }, 'clawmaster: voice routes and tools');
}

/** Run a tool body with the lifetime signal combined into the caller's. */
function runTool(exec: ToolRunContext, action: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  return Promise.resolve().then(() => {
    exec.signal?.throwIfAborted();
    return action(exec.signal ?? new AbortController().signal);
  });
}

function json(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } });
}

function failure(error: unknown): Response {
  const known = error instanceof VoiceError
    ? error
    : new VoiceError('invalid_request', error instanceof Error ? error.message : String(error));
  return Response.json({ error: { code: known.code, message: known.message } }, { status: 400, headers: { 'cache-control': 'no-store' } });
}

/** Re-exported for tests and for the panel's default title preview. */
export { defaultTitle };
