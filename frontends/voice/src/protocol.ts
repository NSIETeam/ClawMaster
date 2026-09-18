/**
 * The Voice wire contract: what the Sidebar panel and the Host agree on.
 * Pure formatting and validation only — this module must never import a Node built-in, because the
 * browser half bundles it too.
 */
import { z } from 'zod';

export const VOICE_SESSION_PATH = '/api/clawmaster/voice/session';
export const VOICE_AUDIO_PATH = '/api/clawmaster/voice/audio';
export const VOICE_STATE_PATH = '/api/clawmaster/voice/state';
export const VOICE_SPEAKERS_PATH = '/api/clawmaster/voice/speakers';
export const VOICE_MODELS_PATH = '/api/clawmaster/voice/models';

/** One utterance may not be longer than this; the panel endpoints on silence well before it. */
export const MAX_UTTERANCE_MS = 30_000;
/** One posted PCM chunk (already endpointed by the panel) may not exceed this. */
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
/** The speech engine wants 16 kHz mono; the panel resamples from the device rate before sending. */
export const SAMPLE_RATE = 16_000;
/** Silence this long ends an utterance in the panel. */
export const ENDPOINT_SILENCE_MS = 700;
/** Audio kept before the detected speech onset, so a clipped first syllable is still recognized. */
export const PREROLL_MS = 300;

export const utteranceIdSchema = z.string().min(1).max(64);
export const speakerIdSchema = z.string().regex(/^spk-[0-9a-f]{8}$/);
export const sessionIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const voiceStatusSchema = z.enum(['idle', 'listening', 'paused', 'stopped']);
export type VoiceStatus = z.output<typeof voiceStatusSchema>;

/** One speaker as the panel and the note writer see it: a label that can be renamed over time. */
export const speakerSchema = z.object({
  id: speakerIdSchema,
  /** What the user sees: an auto label ("说话人 2") until it is renamed to a real name. */
  name: z.string().min(1).max(120),
  /** True when the name came from the user or from an enrolled voiceprint, not from clustering. */
  named: z.boolean(),
  /** Enrolled voiceprints bound to this label, so a later meeting recognizes the person again. */
  voiceprints: z.number().int().min(0).default(0),
  /** When this speaker was last heard, epoch milliseconds. */
  lastHeardAt: z.number().int().min(0).default(0),
}).strict();
export type Speaker = z.output<typeof speakerSchema>;

/** One recognized turn: the unit the timeline and every later note revision are derived from. */
export const utteranceSchema = z.object({
  id: utteranceIdSchema,
  sessionId: sessionIdSchema,
  /** Milliseconds since the session started. */
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  speakerId: speakerIdSchema,
  text: z.string().max(8000),
  /** Engine confidence in [0,1] when the engine reports one. */
  confidence: z.number().min(0).max(1).optional(),
  /** Root-mean-square level of the segment, kept so a quiet or clipped turn is visible. */
  level: z.number().min(0).max(1).optional(),
}).strict();
export type Utterance = z.output<typeof utteranceSchema>;

/** The whole live state of one recording session, which is what the panel polls. */
export const voiceStateSchema = z.object({
  sessionId: sessionIdSchema,
  title: z.string().max(200),
  status: voiceStatusSchema,
  startedAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  speakers: z.array(speakerSchema),
  utterances: z.array(utteranceSchema),
  /** Engine readiness, so the panel can say why nothing is being transcribed. */
  engine: z.object({
    ready: z.boolean(),
    model: z.string(),
    reason: z.string().optional(),
  }).strict(),
}).strict();
export type VoiceState = z.output<typeof voiceStateSchema>;

export const startSessionSchema = z.object({
  action: z.literal('start'),
  title: z.string().max(200).optional(),
  /** Enroll this session's audio under a project note when the meeting is written up. */
  project: z.string().max(120).optional(),
}).strict();

export const stopSessionSchema = z.object({
  action: z.literal('stop'),
  sessionId: sessionIdSchema,
}).strict();

export const sessionCommandSchema = z.discriminatedUnion('action', [startSessionSchema, stopSessionSchema]);
export type SessionCommand = z.output<typeof sessionCommandSchema>;

/**
 * One posted utterance: the panel already found the speech boundaries and sends 16 kHz mono PCM
 * WAV bytes, so the Host does no audio buffering of its own and a lost post costs one turn only.
 */
export const audioPostSchema = z.object({
  sessionId: sessionIdSchema,
  /** Milliseconds since the session started at which this segment begins. */
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  /** Base64 of a 16 kHz mono 16-bit PCM WAV file. */
  wav: z.string().min(1).max(Math.ceil(MAX_CHUNK_BYTES / 3) * 4),
  /** Channel label when the source is already per-participant; absent for the shared microphone. */
  channel: z.string().max(120).optional(),
  /** A previously enrolled voiceprint the user assigned by hand for this very segment. */
  speakerHint: speakerIdSchema.optional(),
}).strict();
export type AudioPost = z.output<typeof audioPostSchema>;

/** What one posted segment produced: the transcript, the speaker it was attributed to, and its id. */
export const audioReceiptSchema = z.object({
  utterance: utteranceSchema,
  speaker: speakerSchema,
  /** True when the segment created a new speaker label rather than matching an existing one. */
  newSpeaker: z.boolean(),
}).strict();
export type AudioReceipt = z.output<typeof audioReceiptSchema>;

export const speakerCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), sessionId: sessionIdSchema, speakerId: speakerIdSchema, name: z.string().min(1).max(120) }).strict(),
  z.object({ action: z.literal('merge'), sessionId: sessionIdSchema, from: speakerIdSchema, into: speakerIdSchema }).strict(),
  z.object({
    action: z.literal('enroll'),
    /** A name that outlives this meeting: every later meeting tries to match this voiceprint. */
    name: z.string().min(1).max(120),
    /** Base64 of a 16 kHz mono 16-bit PCM WAV file of the person speaking alone. */
    wav: z.string().min(1).max(Math.ceil(MAX_CHUNK_BYTES / 3) * 4),
    /** Bind the voiceprint to a speaker of the running session as well. */
    sessionId: sessionIdSchema.optional(),
    speakerId: speakerIdSchema.optional(),
  }).strict(),
  z.object({ action: z.literal('forget'), name: z.string().min(1).max(120) }).strict(),
]);
export type SpeakerCommand = z.output<typeof speakerCommandSchema>;

export const voiceFailureSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
}).strict();

export const voiceModelsSchema = z.object({
  /** Absolute directory holding the model files. */
  directory: z.string().min(1),
  installed: z.array(z.object({ name: z.string(), bytes: z.number().int().min(0) }).strict()),
  missing: z.array(z.string()),
  /** True when the native speech engine module itself resolved. */
  engine: z.boolean(),
  /** Why the engine is unavailable, when it is. */
  reason: z.string().optional(),
}).strict();
export type VoiceModels = z.output<typeof voiceModelsSchema>;

/** The request envelope every Voice command travels in, mirroring the Notes command route. */
export function voiceCommandEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ request: schema }).strict();
}

/** Ready-made envelopes, so the client and the Host cannot drift apart on the wrapper shape. */
export const sessionCommandEnvelopeSchema = voiceCommandEnvelope(sessionCommandSchema);
export const audioPostEnvelopeSchema = voiceCommandEnvelope(audioPostSchema);
export const speakerCommandEnvelopeSchema = voiceCommandEnvelope(speakerCommandSchema);

/** An auto label for a speaker the clustering has just discovered, e.g. 说话人 2. */
export function defaultSpeakerName(ordinal: number): string {
  return `说话人 ${ordinal}`;
}

/** True when a label is still the auto-generated one, so the panel can italicize it. */
export function isDefaultSpeakerName(name: string): boolean {
  return /^说话人 \d+$/.test(name);
}
