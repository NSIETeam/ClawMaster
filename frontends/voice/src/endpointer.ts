/**
 * Endpoint detection: turn a continuous microphone stream into utterances.
 *
 * The split between "capture" and "recognition" is what makes live dictation cheap: the browser
 * finds the speech boundaries, so the engine only ever decodes a complete sentence instead of a
 * rolling buffer, and one lost network post costs one sentence rather than the whole meeting.
 *
 * Detection is energy-based with an adapting noise floor rather than a neural VAD, deliberately:
 * it costs nothing, it never blocks the audio thread, and its two parameters (how loud counts as
 * speech, how quiet counts as a sentence break) are the two things a user can actually reason about
 * when a room is noisy. Silence *duration* is what ends a sentence; silence *level* only tunes the
 * floor, so a hissing air conditioner cannot hold a sentence open.
 */

/** Frame length in milliseconds. 20 ms is short enough to place a boundary, long enough to be cheap. */
export const FRAME_MS = 20;
/** Audio kept before the detected onset, so a clipped first syllable is still decoded. */
export const PREROLL_MS = 300;
/** Ignore an utterance shorter than this: a door slam is not a sentence. */
export const MIN_UTTERANCE_MS = 250;
/** A sentence is cut here even if the speaker never pauses, so memory and latency stay bounded. */
export const MAX_UTTERANCE_MS = 20_000;
/** Consecutive speech frames needed to call an onset, which rejects a single loud click. */
export const ONSET_FRAMES = 2;

/** A detected utterance, in samples and in session time. */
export interface Utterance {
  /** Mono float samples at the capture rate, including the pre-roll. */
  samples: Float32Array;
  /** Milliseconds since capture started at which the speech itself begins. */
  startMs: number;
  /** Milliseconds since capture started at which the speech ends. */
  endMs: number;
  /** Root-mean-square level of the speech, for the panel's level meter and for later screening. */
  level: number;
}

/** Tunables; the defaults are what ships, and the panel exposes the two the user can judge. */
export interface EndpointerOptions {
  /** Capture sample rate in Hz. */
  sampleRate: number;
  /** A frame is speech when its RMS exceeds the noise floor by this factor times the floor. */
  onsetRatio?: number;
  /** Frames of silence that end an utterance. */
  silenceMs?: number;
  /** What the panel calls "敏感度": higher means quieter speech still counts. */
  sensitivity?: number;
  /** How far back the room level is estimated, in milliseconds. */
  floorMs?: number;
}

/** How an endpointer reports what it decided, so the panel can render a level meter. */
export interface EndpointerStatus {
  /** RMS of the most recent frame. */
  level: number;
  /** The adaptive threshold a frame is compared against. */
  threshold: number;
  /** True while an utterance is open. */
  speaking: boolean;
  /** Milliseconds of audio accepted since capture started. */
  elapsedMs: number;
}

/**
 * Splits a stream of frames into utterances.
 *
 * Feed it fixed-size frames (`frameSamples` of them) and it returns an utterance whenever one ends;
 * `flush()` closes a sentence that is still open when the user stops recording.
 */
export class Endpointer {
  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private readonly silenceFrames: number;
  private readonly onsetRatio: number;
  private readonly sensitivity: number;
  /** Ring of recent frames kept for the pre-roll. */
  private readonly preroll: Float32Array[] = [];
  private readonly prerollFrames: number;
  /** Frames per calibration window. */
  private readonly floorFrames: number;
  /** Calibration windows kept, so the floor looks back over about ten seconds. */
  private readonly floorWindows: number;
  /** Frames of the open utterance, most recent last. */
  private open: Float32Array[] = [];
  /** Frames of the open utterance whose level counted as speech, which is the turn's real length. */
  private voicedFrames = 0;
  private voicedRun = 0;
  private silentRun = 0;
  private elapsedSamples = 0;
  /** Quietest level of each calibration window, oldest first; their minimum is the room's floor. */
  private readonly quietHistory: number[] = [];
  private lastLevel = 0;
  /** Quietest level of the window being filled right now. */
  private quietWindow = 0;
  /** Frames counted into the current calibration window. */
  private quietFrames = 0;

  constructor(options: EndpointerOptions) {
    this.sampleRate = options.sampleRate;
    this.frameSamples = Math.max(1, Math.round((this.sampleRate * FRAME_MS) / 1000));
    this.silenceFrames = Math.max(1, Math.round((options.silenceMs ?? 700) / FRAME_MS));
    this.onsetRatio = options.onsetRatio ?? 2.6;
    this.sensitivity = Math.min(3, Math.max(0.2, options.sensitivity ?? 1));
    this.prerollFrames = Math.max(0, Math.round(PREROLL_MS / FRAME_MS));
    // A window holds a sentence, and ten of them hold a conversation, so the floor is taken over
    // long enough that the speaker cannot outlast it.
    this.floorFrames = Math.max(10, Math.round((options.floorMs ?? 1000) / FRAME_MS));
    this.floorWindows = 10;
  }

  /** Samples per frame, so the caller can buffer the device stream to exactly this. */
  get frameSize(): number {
    return this.frameSamples;
  }

  /** What the panel shows: level, threshold, whether a sentence is open. */
  status(): EndpointerStatus {
    return {
      level: this.lastLevel,
      threshold: this.threshold(),
      speaking: this.open.length > 0,
      elapsedMs: Math.round((this.elapsedSamples / this.sampleRate) * 1000),
    };
  }

  /**
   * Feed one frame.
   * @param frame - Exactly `frameSize` mono samples at the capture rate.
   * @returns The utterance that just ended, when this frame closed one.
   */
  push(frame: Float32Array): Utterance | undefined {
    if (frame.length !== this.frameSamples) {
      throw new Error(`A frame must hold ${this.frameSamples} samples, received ${frame.length}.`);
    }
    const level = rmsOf(frame);
    this.lastLevel = level;
    this.observeFloor(level);
    const threshold = this.threshold();
    const speech = level >= threshold;
    this.elapsedSamples += frame.length;

    if (this.open.length === 0) {
      this.preroll.push(frame);
      while (this.preroll.length > this.prerollFrames) this.preroll.shift();
      this.voicedRun = speech ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= ONSET_FRAMES) {
        // The run began `voicedRun - 1` frames before this one. Hand the decoder the pre-roll that
        // precedes the onset plus the run itself, so a clipped first syllable is still decoded while
        // earlier room tone is left behind.
        const beforeOnset = this.preroll.length - this.voicedRun;
        this.open = this.preroll.slice(Math.max(0, beforeOnset));
        this.voicedFrames = this.voicedRun;
        this.silentRun = 0;
        this.preroll.length = 0;
      }
      return undefined;
    }

    this.open.push(frame);
    this.voicedFrames = speech ? this.voicedFrames + 1 : this.voicedFrames;
    this.silentRun = speech ? 0 : this.silentRun + 1;
    const openMs = this.open.length * FRAME_MS;
    if (this.silentRun >= this.silenceFrames || openMs >= MAX_UTTERANCE_MS) {
      return this.close();
    }
    return undefined;
  }

  /**
   * Close whatever is open, for when the user stops recording.
   * @returns The final utterance, or undefined when there was nothing worth decoding.
   */
  flush(): Utterance | undefined {
    return this.open.length === 0 ? undefined : this.close();
  }

  /** Drop the open utterance and the pre-roll, for when the panel pauses without ending the session. */
  reset(): void {
    this.open = [];
    this.preroll.length = 0;
    this.voicedFrames = 0;
    this.voicedRun = 0;
    this.silentRun = 0;
  }

  private close(): Utterance | undefined {
    const frames = this.open;
    const voicedMs = this.voicedFrames * FRAME_MS;
    this.open = [];
    this.voicedFrames = 0;
    this.voicedRun = 0;
    this.silentRun = 0;
    // Trailing silence is not speech: cut it so the decoder is not fed room tone.
    let trimmed = 0;
    while (frames.length > 0) {
      const last = frames[frames.length - 1];
      if (last === undefined || rmsOf(last) >= this.threshold() * 0.6) break;
      frames.pop();
      trimmed += 1;
    }
    const total = frames.reduce((sum, frame) => sum + frame.length, 0);
    if (total === 0) return undefined;
    const durationMs = (total / this.sampleRate) * 1000;
    if (durationMs < MIN_UTTERANCE_MS) return undefined;
    const samples = new Float32Array(total);
    let offset = 0;
    for (const frame of frames) {
      samples.set(frame, offset);
      offset += frame.length;
    }
    // The buffer includes the pre-roll for the decoder's benefit, but the turn is the speech inside
    // it: the timeline reports the speech span, so a transcript's timestamps line up with the audio
    // and two turns can never overlap because of padding.
    const elapsedMs = (this.elapsedSamples / this.sampleRate) * 1000;
    const endMs = elapsedMs - trimmed * FRAME_MS;
    const speechMs = Math.min(voicedMs, durationMs);
    return {
      samples,
      startMs: Math.max(0, Math.round(endMs - speechMs)),
      endMs: Math.round(endMs),
      level: Math.round(rmsOf(samples) * 1000) / 1000,
    };
  }

  /** The level a frame must reach to count as speech, with the user's sensitivity folded in. */
  private threshold(): number {
    // A quiet room must not make the threshold so low that hiss is speech, so it never drops below
    // a floor that is inaudible to a person but well above digital silence.
    const base = Math.max(this.noiseFloor() * this.onsetRatio, 0.004);
    return base / this.sensitivity;
  }

  /**
   * The room's noise level: the quietest frame of the quietest recent calibration window.
   *
   * Decimation is what keeps this honest. Averaging, or a percentile of all frames, lets speech in —
   * and once speech is in, the threshold climbs toward the speaker and sentences stop closing. Taking
   * only the minimum of each window, then the minimum across windows, means a loud frame can never
   * raise the floor; at worst a speaker who talks for ten seconds straight holds it where it was. A
   * steady hiss still sets it, because the quietest frame in a hissing room is the hiss.
   */
  private noiseFloor(): number {
    if (this.quietHistory.length === 0) return 0;
    let lowest = this.quietHistory[0]!;
    for (const level of this.quietHistory) if (level < lowest) lowest = level;
    return lowest;
  }

  /** Remember this frame's level; one minimum per calibration window survives. */
  private observeFloor(level: number): void {
    this.quietWindow = this.quietFrames === 0 ? level : Math.min(this.quietWindow, level);
    this.quietFrames += 1;
    if (this.quietFrames < this.floorFrames) return;
    this.quietHistory.push(this.quietWindow);
    while (this.quietHistory.length > this.floorWindows) this.quietHistory.shift();
    this.quietWindow = 0;
    this.quietFrames = 0;
  }
}

/** Root-mean-square level of a frame, in [0,1]. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/**
 * Split an arbitrary buffer into frames, and feed each one.
 * The tail is ignored: a partial frame is not enough audio to place a boundary on, and the next call
 * carries it over, so a caller may hand over whatever the device produced.
 * @param endpointer - The detector to feed.
 * @param samples - New audio in capture order.
 * @returns Every utterance the new audio completed.
 */
export function feed(endpointer: Endpointer, samples: Float32Array): Utterance[] {
  const done: Utterance[] = [];
  const size = endpointer.frameSize;
  for (let offset = 0; offset + size <= samples.length; offset += size) {
    const utterance = endpointer.push(samples.subarray(offset, offset + size));
    if (utterance !== undefined) done.push(utterance);
  }
  return done;
}
