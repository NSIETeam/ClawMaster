/**
 * Browser-side Voice transport over the plugin's own authenticated Fetch routes.
 *
 * The carrier owns authentication and the origin check, so this is a thin typed wrapper with one job
 * beyond parsing: turning every failure into a {@link VoiceApiError} carrying the server's code, so
 * the panel can say "the engine has no model files" instead of "request failed".
 */
import {
  VOICE_AUDIO_PATH, VOICE_MODELS_PATH, VOICE_SESSION_PATH, VOICE_SPEAKERS_PATH, VOICE_STATE_PATH,
  audioReceiptSchema, speakerCommandEnvelopeSchema, sessionCommandEnvelopeSchema, audioPostEnvelopeSchema,
  voiceFailureSchema, voiceModelsSchema, voiceStateSchema,
  type AudioPost, type AudioReceipt, type Speaker, type SpeakerCommand, type SessionCommand, type VoiceModels, type VoiceState,
} from './protocol.ts';
import type { SessionIndex } from './store.ts';
import type { TranscriptSink } from './recorder.ts';

/** One rejected Voice call, carrying the server's failure code. */
export class VoiceApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'VoiceApiError';
  }
}

/** What a speakers listing contains: the enrolled names and the live session, if any. */
export interface SpeakerListing {
  enrolled: string[];
  state: VoiceState | null;
}

/** Typed calls against the Voice routes. */
export class VoiceApi implements TranscriptSink {
  constructor(private readonly request: typeof fetch) {}

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.request(path, { credentials: 'same-origin', ...init });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new VoiceApiError('storage_unavailable', 'Voice response was not JSON.');
    }
    if (!response.ok) {
      const failure = voiceFailureSchema.safeParse(payload);
      if (failure.success) throw new VoiceApiError(failure.data.error.code, failure.data.error.message);
      throw new VoiceApiError('storage_unavailable', `Voice request failed with ${response.status}.`);
    }
    return payload;
  }

  /** The live session, or null when nothing is recording. */
  async live(): Promise<VoiceState | null> {
    return voiceStateSchema.nullable().parse(await this.call(VOICE_STATE_PATH));
  }

  /** A finished recording by id, which is what a write-up is derived from. */
  async session(sessionId: string): Promise<SessionIndex | null> {
    const query = new URLSearchParams({ sessionId });
    return await this.call(`${VOICE_STATE_PATH}?${query.toString()}`) as SessionIndex | null;
  }

  /** Whether the offline engine and its model files are ready. */
  async models(): Promise<VoiceModels> {
    return voiceModelsSchema.parse(await this.call(VOICE_MODELS_PATH));
  }

  /** Enrolled voiceprint names and the current state. */
  async speakers(): Promise<SpeakerListing> {
    return await this.call(VOICE_SPEAKERS_PATH) as SpeakerListing;
  }

  /** Start a recording session. */
  async start(command: Extract<SessionCommand, { action: 'start' }>): Promise<VoiceState> {
    return voiceStateSchema.parse(await this.call(VOICE_SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sessionCommandEnvelopeSchema.parse({ request: command })),
    }));
  }

  /** Stop a recording session. */
  async stop(sessionId: string): Promise<VoiceState> {
    return voiceStateSchema.parse(await this.call(VOICE_SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sessionCommandEnvelopeSchema.parse({ request: { action: 'stop', sessionId } })),
    }));
  }

  /** Post one endpointed utterance for recognition and attribution. */
  async postAudio(input: Omit<AudioPost, 'channel' | 'speakerHint'> & { channel?: string }): Promise<AudioReceipt> {
    return audioReceiptSchema.parse(await this.call(VOICE_AUDIO_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(audioPostEnvelopeSchema.parse({ request: input })),
    }));
  }

  /** Rename, merge, enroll or forget a speaker. */
  async speakersCommand(command: SpeakerCommand): Promise<Speaker | { name: string; vectors: number } | { forgotten: boolean }> {
    return await this.call(VOICE_SPEAKERS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(speakerCommandEnvelopeSchema.parse({ request: command })),
    }) as Speaker | { name: string; vectors: number } | { forgotten: boolean };
  }
}
