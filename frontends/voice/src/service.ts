/**
 * The Voice service: everything the routes and the agent tools call.
 *
 * It owns one live session at a time — a person is in one meeting at a time — and it keeps this
 * invariant: audio in, a durable timeline event out, then state. Nothing is transcribed into memory
 * only, so a crash never loses a turn that the user already saw.
 */
import { join } from 'node:path';
import { decodeWav, encodeWav, rms } from './wav.ts';
import { loadEngine, resolveModelDirectory, inspectModels, unavailableEngine, type SpeechEngine, type Transcript } from './engine.ts';
import { SpeakerBook, SpeakerTracker, newSpeakerId } from './speakers.ts';
import { TranscriptStore, newSessionId, newUtteranceId, replay, timelinePathOf, voiceDirectoryOf, type SessionIndex, type StoreFs } from './store.ts';
import {
  SAMPLE_RATE,
  type AudioPost,
  type AudioReceipt,
  type Speaker,
  type SpeakerCommand,
  type Utterance,
  type VoiceModels,
  type VoiceState,
} from './protocol.ts';

/** Everything the service needs that differs between the app and a test. */
export interface VoiceServiceOptions {
  /** Absolute vault root: the timelines live in `.clawmaster/voice` under it. */
  vaultRoot: string;
  /** Where enrolled voiceprints and downloaded models live; outside the vault. */
  dataRoot: string;
  /** Model directory override; defaults to `<dataRoot>/models`. */
  modelDirectory?: string;
  /** Threads the native engine may use. */
  threads: number;
  /** Whisper language hint, 'auto' to detect. */
  language: string;
  /** Filesystem the store writes through. */
  fs: StoreFs;
  /** Clock, so tests are deterministic. */
  now: () => number;
  /** Engine factory override, so the Host can be exercised without a model download. */
  createEngine?: (options: { directory: string; threads: number; language: string }) => Promise<SpeechEngine>;
}

/** A failure the routes can turn into a typed response instead of a 500 with a stack trace. */
export class VoiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'VoiceError';
  }
}

/**
 * The live recording service.
 * One instance per open component; every route and tool goes through it so there is a single place
 * where "what is being recorded" is decided.
 */
export class VoiceService {
  private engine: SpeechEngine | undefined;
  private engineFailure: string | undefined;
  private tracker: SpeakerTracker | undefined;
  private store: TranscriptStore | undefined;
  private book: SpeakerBook;
  private readonly modelDirectory: string;
  private starting: Promise<void> | undefined;

  constructor(private readonly options: VoiceServiceOptions) {
    this.book = new SpeakerBook(join(options.dataRoot, 'speakers.json'));
    this.modelDirectory = resolveModelDirectory(options.modelDirectory, options.dataRoot);
  }

  /** The session currently being recorded, if any. */
  get live(): SessionIndex | undefined {
    const index = this.store?.current;
    return index === undefined || index.status === 'stopped' ? undefined : index;
  }

  /** Whether the speech engine can transcribe, for the panel to explain itself. */
  get engineReady(): boolean {
    return this.engine !== undefined;
  }

  /** Open the enrolled voiceprints, so the first segment can already be attributed by name. */
  async open(): Promise<void> {
    await this.book.load();
    await this.ensureEngine();
  }

  /** Release native resources; the timeline is already durable, so nothing is lost. */
  close(): void {
    this.engine?.dispose();
    this.engine = undefined;
  }

  /** What models are installed and whether the native engine resolved. */
  models(): VoiceModels {
    const { installed, missing } = inspectModels(this.modelDirectory);
    return {
      directory: this.modelDirectory,
      installed,
      missing,
      engine: this.engineReady,
      reason: this.engineFailure,
    };
  }

  /** The names the panel may assign without recording a new voiceprint. */
  enrolledNames(): string[] {
    return this.book.names();
  }

  /**
   * Start a recording session.
   * @param title - What the meeting is called; a default is derived from the time when omitted.
   * @param project - The project note a later write-up should link to.
   * @returns The state of the fresh session.
   */
  async start(title: string | undefined, project: string | undefined): Promise<VoiceState> {
    await this.ensureEngine();
    await this.book.load();
    const at = this.options.now();
    const sessionId = newSessionId();
    const store = new TranscriptStore(this.options.fs, this.options.vaultRoot, sessionId);
    const named = title?.trim();
    const index = await store.open(named === undefined || named === '' ? defaultTitle(at) : named, project, at);
    this.store = store;
    this.tracker = new SpeakerTracker(undefined, undefined, this.book);
    return this.stateOf(index);
  }

  /**
   * Continue an existing session after a restart, reading its timeline back.
   * @param sessionId - The session to reopen.
   * @returns The rebuilt state, or undefined when the timeline does not exist.
   */
  async resume(sessionId: string): Promise<VoiceState | undefined> {
    await this.ensureEngine();
    await this.book.load();
    const store = new TranscriptStore(this.options.fs, this.options.vaultRoot, sessionId);
    const index = await store.load();
    if (index === undefined) return undefined;
    this.store = store;
    this.tracker = new SpeakerTracker(undefined, undefined, this.book);
    this.tracker.restore(index.speakers, index.centroids);
    return this.stateOf(index);
  }

  /**
   * Read a session timeline without adopting it as the live one.
   * @param sessionId - The session to read.
   * @returns The index, or undefined when it does not exist.
   */
  async readSession(sessionId: string): Promise<SessionIndex | undefined> {
    try {
      const text = await this.options.fs.readFile(timelinePathOf(this.options.vaultRoot, sessionId), 'utf8');
      return replay(text);
    } catch {
      return undefined;
    }
  }

  /** Stop the live session; the timeline keeps every turn. */
  async stop(): Promise<VoiceState> {
    const index = this.requireLive();
    await this.store!.recordStatus('stopped', this.options.now());
    return this.stateOf(index);
  }

  /** The live state, for the panel's poll. */
  state(): VoiceState | undefined {
    const index = this.store?.current;
    return index === undefined ? undefined : this.stateOf(index);
  }

  /**
   * Accept one endpointed segment: transcribe it, attribute it to a speaker, and make it durable.
   * @param post - The segment the panel captured.
   * @returns The recognized turn plus the speaker it was attributed to.
   */
  async ingest(post: AudioPost): Promise<AudioReceipt> {
    const index = this.requireLive();
    if (post.sessionId !== index.sessionId) {
      throw new VoiceError('unknown_session', `Session ${post.sessionId} is not the one recording.`);
    }
    if (post.endMs < post.startMs) throw new VoiceError('invalid_request', 'A segment cannot end before it starts.');
    if (post.endMs - post.startMs > 60_000) throw new VoiceError('invalid_request', 'A segment longer than a minute was rejected.');
    const { samples } = decodeSegment(post.wav);
    const at = this.options.now();
    const speech = await this.transcribe(samples);
    const embedding = await this.embed(samples);
    const tracker = this.requireTracker();
    const known = post.speakerHint === undefined ? undefined : tracker.findById(post.speakerHint);
    if (post.speakerHint !== undefined && known === undefined) {
      throw new VoiceError('unknown_speaker', `No speaker ${post.speakerHint} in the live session.`);
    }
    // A manual assignment is authoritative: the clusterer must not also absorb the segment and grow
    // an unnamed label behind the user's back.
    const shaped = known === undefined ? tracker.attribute(embedding, at) : undefined;
    const speaker = known ?? shaped!.speaker;
    const createdSpeaker = shaped?.created ?? false;
    // The store's index is what the panel reads, so a label must reach it even when it came from a
    // manual assignment rather than from clustering.
    if (index.speakers.every(existing => existing.id !== speaker.id)) {
      const centroids = tracker.centroids();
      const position = tracker.speakers().findIndex(candidate => candidate.id === speaker.id);
      await this.store!.recordSpeaker(speaker, position < 0 ? undefined : centroids[position], at);
    }
    const sequence = index.lastSequence + 1;
    const utterance: Utterance = {
      id: newUtteranceId(sequence),
      sessionId: index.sessionId,
      startMs: Math.round(post.startMs),
      endMs: Math.round(post.endMs),
      speakerId: speaker.id,
      text: speech.text,
      ...(speech.confidence === undefined ? {} : { confidence: speech.confidence }),
      level: Math.round(rms(samples) * 1000) / 1000,
    };
    await this.store!.recordUtterance(utterance, at);
    return { utterance, speaker, newSpeaker: createdSpeaker };
  }

  /** Rename a label, so every turn already recorded under it reads with the new name. */
  async rename(speakerId: string, name: string): Promise<Speaker> {
    this.requireLive();
    const trimmed = name.trim();
    if (trimmed === '') throw new VoiceError('invalid_request', 'A speaker name cannot be empty.');
    const renamed = this.requireTracker().rename(speakerId, trimmed);
    if (renamed === undefined) throw new VoiceError('unknown_speaker', `Unknown speaker ${speakerId}.`);
    await this.store!.recordRename(speakerId, trimmed, this.options.now());
    return renamed;
  }

  /** Fold one label into another after the user hears that they are the same person. */
  async merge(from: string, into: string): Promise<Speaker> {
    this.requireLive();
    if (from === into) throw new VoiceError('invalid_request', 'A speaker cannot be merged into itself.');
    const merged = this.requireTracker().merge(from, into);
    if (merged === undefined) throw new VoiceError('unknown_speaker', 'Both speakers must exist in the live session.');
    await this.store!.recordMerge(from, into, this.options.now());
    return merged;
  }

  /**
   * Enroll a voiceprint under a name, so later meetings recognize the person without being told.
   * @param name - The person's name.
   * @param wav - Base64 WAV of that person speaking alone.
   * @param speakerId - A label of the live session to rename as well.
   * @returns The name and how many vectors it now holds.
   */
  async enroll(name: string, wav: string, speakerId: string | undefined): Promise<{ name: string; vectors: number }> {
    const trimmed = name.trim();
    if (trimmed === '') throw new VoiceError('invalid_request', 'An enrolled voice needs a name.');
    const { samples } = decodeSegment(wav);
    const embedding = await this.embed(samples);
    if (embedding === undefined) {
      throw new VoiceError('engine_unavailable', this.engineFailure ?? 'The speech engine cannot compute a voiceprint.');
    }
    await this.book.enroll(trimmed, embedding, this.options.now());
    if (speakerId !== undefined) {
      const renamed = this.requireTracker().rename(speakerId, trimmed);
      if (renamed !== undefined) await this.store!.recordEnrollment(speakerId, trimmed, this.options.now());
    }
    return { name: trimmed, vectors: this.book.vectorCount(trimmed) };
  }

  /** Forget an enrolled voiceprint. */
  async forget(name: string): Promise<boolean> {
    return this.book.forget(name.trim());
  }

  /**
   * Run one command from the panel or a tool.
   * @param command - The speaker management command.
   * @returns A small result describing what changed.
   */
  async runSpeakerCommand(command: SpeakerCommand): Promise<unknown> {
    switch (command.action) {
      case 'rename': return this.rename(command.speakerId, command.name);
      case 'merge': return this.merge(command.from, command.into);
      case 'enroll': {
        const result = await this.enroll(command.name, command.wav, command.speakerId);
        return result;
      }
      case 'forget': return { forgotten: await this.forget(command.name) };
    }
  }

  /** Transcribe one buffer through the live engine, reporting why it cannot when it cannot. */
  private async transcribe(samples: Float32Array): Promise<Transcript> {
    const engine = await this.ensureEngine();
    return engine.transcribe(samples);
  }

  private async embed(samples: Float32Array) {
    const engine = await this.ensureEngine();
    return engine.embedding(samples);
  }

  /** Load the engine once; a failure is a reported state, not an exception on every segment. */
  private async ensureEngine(): Promise<SpeechEngine> {
    if (this.engine !== undefined) return this.engine;
    if (this.starting !== undefined) {
      await this.starting;
      return this.engine ?? unavailableEngine('engine failed to load', SAMPLE_RATE);
    }
    this.starting = (async () => {
      try {
        const options = { directory: this.modelDirectory, threads: this.options.threads, language: this.options.language };
        const engine = await (this.options.createEngine ?? loadEngine)(options);
        if (engine.description.startsWith('unavailable: ')) {
          this.engineFailure = engine.description.slice('unavailable: '.length);
          return;
        }
        this.engine = engine;
        this.engineFailure = undefined;
      } catch (error) {
        this.engineFailure = error instanceof Error ? error.message : String(error);
      } finally {
        this.starting = undefined;
      }
    })();
    await this.starting;
    return this.engine ?? unavailableEngine(this.engineFailure ?? 'unknown engine failure', SAMPLE_RATE);
  }

  private requireLive(): SessionIndex {
    const index = this.live;
    if (index === undefined || this.store === undefined) {
      throw new VoiceError('no_session', 'No recording session is running. Start one first.');
    }
    return index;
  }

  private requireTracker(): SpeakerTracker {
    if (this.tracker === undefined) throw new VoiceError('no_session', 'No recording session is running.');
    return this.tracker;
  }

  private stateOf(index: SessionIndex): VoiceState {
    return {
      sessionId: index.sessionId,
      title: index.title,
      status: index.status,
      startedAt: index.startedAt,
      updatedAt: index.updatedAt,
      speakers: index.speakers.map(speaker => ({ ...speaker })),
      utterances: index.utterances.map(utterance => ({ ...utterance })),
      engine: {
        ready: this.engineReady,
        model: this.engine?.description ?? `not loaded (${this.modelDirectory})`,
        ...(this.engineFailure === undefined ? {} : { reason: this.engineFailure }),
      },
    };
  }
}

/** A default session title from the moment it started. */
export function defaultTitle(at: number): string {
  const date = new Date(at);
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `录音 ${stamp}`;
}

/** Decode one posted WAV, rejecting a rate the engine cannot use. */
export function decodeSegment(wav: string): { samples: Float32Array; sampleRate: number } {
  const bytes = Buffer.from(wav, 'base64');
  const pcm = decodeWav(new Uint8Array(bytes));
  if (pcm.sampleRate !== SAMPLE_RATE) {
    throw new VoiceError('invalid_request', `Audio must be ${SAMPLE_RATE} Hz mono; received ${pcm.sampleRate} Hz.`);
  }
  if (pcm.samples.length === 0) throw new VoiceError('invalid_request', 'The posted segment held no audio.');
  return pcm;
}

/** Re-exported so tests and the model fetcher can build the same WAV the panel sends. */
export { encodeWav, newSpeakerId, timelinePathOf, voiceDirectoryOf };
