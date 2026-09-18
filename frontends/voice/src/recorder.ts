/**
 * Microphone capture: device audio in, one posted utterance out.
 *
 * The seams are injected on purpose. The panel passes the platform's audio objects; a test passes
 * fakes. That is what lets the timing, resampling and posting rules be verified without a microphone,
 * which is the only way these rules can be checked in CI at all.
 *
 * Two properties matter more than throughput:
 * - The audio graph is torn down on stop, so the microphone indicator goes away and a long meeting
 *   does not leak a context per start.
 * - A post that fails is retried once and then dropped with a message, because a transcript with a
 *   hole is better than a recording that stops on the first network hiccup.
 */
import { Endpointer, type Utterance } from './endpointer.ts';
import { VoiceApiError } from './voice-api.ts';
import { encodeWav, resample, toBase64 } from './wav.ts';
import { SAMPLE_RATE, type AudioReceipt } from './protocol.ts';

/** The audio surface of the platform, narrowed to what capture actually uses. */
export interface AudioPlatform {
  /** True when the environment can capture at all. */
  supported(): boolean;
  /** Request the microphone; rejects with the platform's own error when the user declines. */
  capture(constraints: { channelCount?: number; echoCancellation?: boolean; noiseSuppression?: boolean }): Promise<CaptureDevice>;
}

/** One open capture device. */
export interface CaptureDevice {
  /** The device's own sample rate, which is usually 48 kHz and rarely 16 kHz. */
  readonly sampleRate: number;
  /** Begin delivering mono frames of `frameSize` samples at the device rate. */
  start(frameSize: number, onFrame: (frame: Float32Array) => void): void;
  /** Stop delivering audio and release the device. */
  stop(): void;
}

/** What the panel shows while recording. */
export interface RecorderStatus {
  recording: boolean;
  /** Milliseconds of audio captured so far. */
  elapsedMs: number;
  /** Level of the most recent frame, for the meter. */
  level: number;
  /** Utterances decoded and stored so far. */
  turns: number;
  /** The last problem, kept until the next successful post. */
  problem?: string;
}

/** Everything the recorder needs to post a turn, which is the Voice client above the wire. */
export interface TranscriptSink {
  postAudio(input: {
    sessionId: string;
    startMs: number;
    endMs: number;
    wav: string;
    channel?: string;
  }): Promise<AudioReceipt>;
}

/** Tunables the panel may expose. */
export interface RecorderOptions {
  /** What the panel calls 敏感度. */
  sensitivity?: number;
  /** Milliseconds of silence that end a sentence. */
  silenceMs?: number;
  /** Deliver the panel's own copy of every frame, for a level meter. */
  onStatus?: (status: RecorderStatus) => void;
}

/**
 * Captures the microphone and posts one utterance at a time.
 *
 * `start()` needs a live session id from the Host; the recorder never creates one, so the timeline and
 * the audio can never disagree about which meeting is being recorded.
 */
export class Recorder {
  private device: CaptureDevice | undefined;
  private endpointer: Endpointer | undefined;
  private sessionId: string | undefined;
  private sampleRate = SAMPLE_RATE;
  /** Left-over samples from the previous callback, so frames stay aligned across chunks. */
  private carry = new Float32Array(0);
  private turns = 0;
  private startedAtMs = 0;
  private problem: string | undefined;
  private posting: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly platform: AudioPlatform,
    private readonly sink: TranscriptSink,
    private readonly options: RecorderOptions = {},
  ) {}

  /** True when this environment can record. */
  get supported(): boolean {
    return this.platform.supported();
  }

  /** True while the microphone is open. */
  get recording(): boolean {
    return this.device !== undefined;
  }

  /**
   * Open the microphone and begin posting utterances.
   * @param sessionId - The Host session to write into.
   * @returns The device's sample rate, so the panel can say what it is capturing.
   */
  async start(sessionId: string): Promise<number> {
    if (this.device !== undefined) throw new Error('Recording is already running.');
    // Echo cancellation and noise suppression are off: a meeting is exactly the case where the other
    // participants' voices must be captured, and suppression flattens the cues speaker separation needs.
    const device = await this.platform.capture({ channelCount: 1, echoCancellation: false, noiseSuppression: false });
    this.sessionId = sessionId;
    this.sampleRate = device.sampleRate;
    this.carry = new Float32Array(0);
    this.turns = 0;
    this.problem = undefined;
    this.startedAtMs = nowMs();
    this.endpointer = new Endpointer({
      sampleRate: device.sampleRate,
      ...(this.options.sensitivity === undefined ? {} : { sensitivity: this.options.sensitivity }),
      ...(this.options.silenceMs === undefined ? {} : { silenceMs: this.options.silenceMs }),
    });
    this.device = device;
    device.start(this.endpointer.frameSize, frame => this.onFrame(frame));
    this.publish();
    return device.sampleRate;
  }

  /** Stop recording, post the sentence still open, and release the microphone. */
  async stop(): Promise<void> {
    const device = this.device;
    const endpointer = this.endpointer;
    this.device = undefined;
    this.endpointer = undefined;
    if (device === undefined || endpointer === undefined) return;
    device.stop();
    const final = endpointer.flush();
    if (final !== undefined) await this.enqueue(final);
    await this.posting;
    this.publish();
  }

  /** The most recent status, for a panel that just mounted. */
  status(): RecorderStatus {
    return {
      recording: this.recording,
      elapsedMs: this.device === undefined ? 0 : Math.round(nowMs() - this.startedAtMs),
      level: this.endpointer?.status().level ?? 0,
      turns: this.turns,
      ...(this.problem === undefined ? {} : { problem: this.problem }),
    };
  }

  /** Drop the current session's state without emitting the open sentence. */
  reset(): void {
    this.endpointer?.reset();
    this.carry = new Float32Array(0);
  }

  /** One frame from the device: feed the detector and post whatever it completed. */
  private onFrame(frame: Float32Array): void {
    const endpointer = this.endpointer;
    if (endpointer === undefined) return;
    // The device delivers frames of its own size; the detector needs exactly `frameSize`, so a
    // chunk that does not divide evenly is carried over rather than drifting out of alignment.
    let pending: Float32Array;
    if (this.carry.length > 0) {
      pending = new Float32Array(this.carry.length + frame.length);
      pending.set(this.carry, 0);
      pending.set(frame, this.carry.length);
    } else {
      pending = frame;
    }
    const size = endpointer.frameSize;
    let offset = 0;
    while (offset + size <= pending.length) {
      const utterance = endpointer.push(pending.subarray(offset, offset + size));
      offset += size;
      if (utterance !== undefined) void this.enqueue(utterance);
    }
    this.carry = offset === pending.length ? new Float32Array(0) : pending.slice(offset);
    this.publish();
  }

  /** Resample, wrap and post one utterance, keeping posts in order. */
  private async enqueue(utterance: Utterance): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId === undefined) return;
    const samples = this.sampleRate === SAMPLE_RATE
      ? utterance.samples
      : resample(utterance.samples, this.sampleRate, SAMPLE_RATE);
    const wav = toBase64(encodeWav({ samples, sampleRate: SAMPLE_RATE }));
    const input = { sessionId, startMs: utterance.startMs, endMs: utterance.endMs, wav };
    this.posting = this.posting.then(async () => {
      try {
        await this.postWithRetry(input);
        this.turns += 1;
        this.problem = undefined;
      } catch (error) {
        // The timeline keeps every turn that did arrive; the hole is reported rather than hidden.
        this.problem = messageOf(error);
      }
      this.publish();
    });
    await this.posting;
  }

  /**
   * Post once, and retry once only when the failure could be transient.
   *
   * A rejected segment — a wrong sample rate, an unknown session — will be rejected again, so
   * retrying it would only delay the next sentence. A transport failure is worth one more try, and
   * after that the turn is reported and dropped rather than stalling capture.
   */
  private async postWithRetry(input: Parameters<TranscriptSink['postAudio']>[0]): Promise<unknown> {
    try {
      return await this.sink.postAudio(input);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      return await this.sink.postAudio(input);
    }
  }

  private publish(): void {
    this.options.onStatus?.(this.status());
  }
}

/** Wall-clock milliseconds, read from the platform rather than the injected test clock. */
function nowMs(): number {
  return Date.now();
}

/** A human-readable reason for a failed post, whether it came from the wire or the transport. */
function messageOf(error: unknown): string {
  if (error instanceof VoiceApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * True when retrying the same post could plausibly succeed.
 * Every code except a rejected request is treated as transient, because the server that answers with
 * `no_session` or `invalid_request` will answer the same way a moment later.
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof VoiceApiError)) return true;
  return error.code !== 'invalid_request' && error.code !== 'no_session' && error.code !== 'unknown_session' && error.code !== 'unknown_speaker';
}

/**
 * The browser's audio objects, behind the `AudioPlatform` seam.
 * Kept in a separate function so the panel's module can import the recorder without importing Web
 * Audio at module scope, which would break a server render or a jsdom test.
 * @returns The platform, or undefined when this environment has no Web Audio.
 */
export function browserAudioPlatform(): AudioPlatform | undefined {
  const scope = globalThis as {
    AudioContext?: new (options?: { sampleRate?: number }) => BrowserAudioContext;
    webkitAudioContext?: new (options?: { sampleRate?: number }) => BrowserAudioContext;
    navigator?: { mediaDevices?: { getUserMedia?: (constraints: unknown) => Promise<MediaStreamLike> } };
  };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  const media = scope.navigator?.mediaDevices;
  if (Context === undefined || typeof media?.getUserMedia !== 'function') return undefined;
  return {
    supported: () => true,
    async capture(constraints) {
      const stream = await media.getUserMedia!({
        audio: {
          channelCount: constraints.channelCount ?? 1,
          echoCancellation: constraints.echoCancellation ?? false,
          noiseSuppression: constraints.noiseSuppression ?? false,
        },
      });
      const context = new Context({ sampleRate: SAMPLE_RATE });
      // A context created before the device is resumed can start suspended, and a suspended context
      // delivers no frames at all, which looks exactly like a permission problem.
      if (context.state === 'suspended') await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const device: CaptureDevice = {
        sampleRate: context.sampleRate,
        start(frameSize, onFrame) {
          void frameSize;
          processor.onaudioprocess = (event: AudioProcessingEventLike) => {
            const channel = event.inputBuffer.getChannelData(0);
            onFrame(Float32Array.from(channel));
          };
          source.connect(processor);
          processor.connect(context.destination);
        },
        stop() {
          processor.onaudioprocess = null;
          try { processor.disconnect(); } catch { /* already detached */ }
          try { source.disconnect(); } catch { /* already detached */ }
          for (const track of stream.getTracks?.() ?? []) track.stop?.();
          void context.close();
        },
      };
      return device;
    },
  };
}

/** The slice of Web Audio this component uses, declared here so no DOM lib version can break it. */
interface BrowserAudioContext {
  sampleRate: number;
  state?: string;
  destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(stream: MediaStreamLike): { connect(target: unknown): void; disconnect(): void };
  createScriptProcessor(bufferSize: number, inputChannels: number, outputChannels: number): {
    onaudioprocess: ((event: AudioProcessingEventLike) => void) | null;
    connect(target: unknown): void;
    disconnect(): void;
  };
}

interface AudioProcessingEventLike {
  inputBuffer: { getChannelData(channel: number): Float32Array };
}

interface MediaStreamLike {
  getTracks?(): Array<{ stop?(): void }>;
}
