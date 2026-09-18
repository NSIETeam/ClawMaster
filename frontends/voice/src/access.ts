/**
 * The companion-plugin handle for Voice.
 *
 * Notes publishes `NOTES_ACCESS_KEY` so a reviewer, an archive writer or a memory bridge can read the
 * vault without duplicating the path policy. Voice does the same for the recording timeline: the note
 * writer (and, later, an archive plugin) reads the transcript through this handle rather than opening
 * `.clawmaster/voice` itself.
 */
import type { SessionIndex } from './store.ts';
import type { Speaker } from './protocol.ts';
import type { VoiceService } from './service.ts';

/** The registry key the Voice plugin publishes under. */
export const VOICE_ACCESS_KEY = 'clawmaster.voice';

/** What a companion plugin may do with a recording. Deliberately read-and-correct only. */
export interface VoiceAccess {
  /** The vault this handle belongs to. */
  readonly vaultRoot: string;
  /** The live session, when one is recording. */
  live(): SessionIndex | undefined;
  /** Read a recorded timeline by id. */
  read(sessionId: string): Promise<SessionIndex | undefined>;
  /** Rename a speaker in the live session. */
  rename(speakerId: string, name: string): Promise<Speaker>;
  /** Enroll a voiceprint from base64 WAV. */
  enroll(name: string, wav: string, speakerId?: string): Promise<{ name: string; vectors: number }>;
  /** Whether the offline engine can transcribe right now. */
  ready(): boolean;
  /** Why it cannot, when it cannot. */
  unavailableReason(): string | undefined;
}

/**
 * Build the handle a companion plugin reads.
 * @param service - The live service.
 * @param vaultRoot - The vault the timelines belong to.
 * @returns A narrow read-and-correct accessor.
 */
export function createVoiceAccess(service: VoiceService, vaultRoot: string): VoiceAccess {
  return {
    vaultRoot,
    live: () => service.live,
    read: sessionId => service.readSession(sessionId),
    rename: (speakerId, name) => service.rename(speakerId, name),
    enroll: (name, wav, speakerId) => service.enroll(name, wav, speakerId),
    ready: () => service.engineReady,
    unavailableReason: () => service.models().reason,
  };
}
