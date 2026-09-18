/**
 * Speaker attribution: turn a stream of voice vectors into stable labels, let a human correct them,
 * and keep the corrections as the derived truth of a recording.
 *
 * Two layers, deliberately separate:
 * - `SpeakerTracker` clusters the vectors of one session into labels (说话人 1, 说话人 2, ...).
 * - `SpeakerBook` persists enrolled voiceprints across sessions, so a person keeps their name.
 *
 * Nothing here guesses a name from what was said: a label changes only when a human renames it, or
 * when it matches a voiceprint that was enrolled by a human. That keeps a wrong attribution visible
 * and correctable instead of silently plausible.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cosine, normalize, type Embedding } from './engine.ts';
import { defaultSpeakerName, type Speaker } from './protocol.ts';

/** Similarity above which two vectors are called the same person. */
export const DEFAULT_MATCH_THRESHOLD = 0.45;
/** A session will not invent more labels than this; beyond it, audio joins the nearest existing one. */
export const DEFAULT_MAX_SPEAKERS = 12;
/** How much a new sample moves a label's centroid. Low enough that one odd turn cannot relabel a person. */
const CENTROID_WEIGHT = 0.25;

/** One label of a running session plus the centroid every later vector is matched against. */
interface TrackedSpeaker {
  speaker: Speaker;
  centroid: Embedding | undefined;
  /** How many segments have been assigned to this label, used when merging centroids. */
  samples: number;
  /** The voiceprint name this label was matched to, when it was matched rather than discovered. */
  enrolledAs: string | undefined;
}

/** The outcome of attributing one vector. */
export interface Attribution {
  speaker: Speaker;
  /** True when this vector created a new label. */
  created: boolean;
  /** The enrolled name this vector matched, when it matched one. */
  enrolledAs?: string;
}

/** An enrolled voiceprint: a name plus the vectors that identify that voice. */
export interface Voiceprint {
  name: string;
  /** Unit vectors, newest last; a name may hold several so pitch and distance do not break it. */
  vectors: number[][];
  updatedAt: number;
}

/**
 * Clusters the voice vectors of one session.
 * The tracker never persists anything on its own: the session store owns durability, so a restart is
 * always reconstructed from the same timeline the notes are derived from.
 */
export class SpeakerTracker {
  private readonly tracks: TrackedSpeaker[] = [];

  constructor(
    private readonly threshold = DEFAULT_MATCH_THRESHOLD,
    private readonly maxSpeakers = DEFAULT_MAX_SPEAKERS,
    private readonly book?: SpeakerBook,
  ) {}

  /** Every label of this session, in discovery order. */
  speakers(): Speaker[] {
    return this.tracks.map(track => track.speaker);
  }

  /** Rebuild the tracker from a persisted timeline, so a restart keeps the labels it had. */
  restore(speakers: readonly Speaker[], centroids: readonly (readonly number[] | undefined)[]): void {
    this.tracks.length = 0;
    speakers.forEach((speaker, index) => {
      const vector = centroids[index];
      this.tracks.push({
        speaker,
        centroid: vector === undefined ? undefined : normalize(Float32Array.from(vector)),
        samples: speaker.voiceprints,
        enrolledAs: undefined,
      });
    });
  }

  /** The centroids of every label, in the same order as `speakers()`, for persistence. */
  centroids(): Array<number[] | undefined> {
    return this.tracks.map(track => track.centroid === undefined ? undefined : [...track.centroid]);
  }

  /**
   * Attribute one utterance.
   * @param embedding - The voice vector, or undefined when the engine cannot compute one.
   * @param at - Epoch milliseconds the segment was heard, for the speaker's lastHeardAt.
   * @returns The label this segment belongs to, creating one when the voice is new.
   */
  attribute(embedding: Embedding | undefined, at: number): Attribution {
    if (embedding === undefined) {
      // Without a vector the segment cannot be clustered; it joins the first label so the timeline
      // stays ordered, and the panel shows that no separation was possible.
      const existing = this.tracks[0];
      if (existing !== undefined) {
        existing.speaker.lastHeardAt = at;
        return { speaker: { ...existing.speaker }, created: false };
      }
      const created = this.create(undefined, at);
      return { speaker: created.speaker, created: true };
    }
    const vector = normalize(embedding);
    const enrolled = this.book?.match(vector, this.threshold);
    let best: TrackedSpeaker | undefined;
    let bestScore = -Infinity;
    for (const track of this.tracks) {
      const centroid = track.centroid;
      if (centroid === undefined) {
        if (best === undefined) best = track;
        continue;
      }
      const score = cosine(vector, centroid);
      if (score > bestScore) {
        bestScore = score;
        best = track;
      }
    }
    if (best !== undefined && (bestScore >= this.threshold || (best.centroid === undefined && this.tracks.length <= this.maxSpeakers))) {
      this.absorb(best, vector, at);
      if (enrolled !== undefined && best.speaker.name !== enrolled.name) {
        // A recognized voice renames the label once, so later segments already carry the right name.
        best.speaker = { ...best.speaker, name: enrolled.name, named: true };
        best.enrolledAs = enrolled.name;
      }
      return attributed(best.speaker, false, enrolled?.name);
    }
    if (this.tracks.length >= this.maxSpeakers && best !== undefined) {
      this.absorb(best, vector, at);
      return attributed(best.speaker, false, enrolled?.name);
    }
    const created = this.create(vector, at, enrolled?.name);
    return attributed(created.speaker, true, enrolled?.name);
  }

  /**
   * Rename one label. The name becomes authoritative for every later segment and every later
   * derivation of the note; nothing has to be rewritten in place.
   * @param speakerId - The label to rename.
   * @param name - The new name.
   * @returns The renamed speaker, or undefined when the label is unknown.
   */
  rename(speakerId: string, name: string): Speaker | undefined {
    const track = this.tracks.find(candidate => candidate.speaker.id === speakerId);
    if (track === undefined) return undefined;
    track.speaker = { ...track.speaker, name, named: true };
    return { ...track.speaker };
  }

  /**
   * Fold one label into another, for when clustering split one person in two.
   * @param from - The label to remove.
   * @param into - The label that keeps every segment.
   * @returns The surviving speaker, or undefined when either label is unknown or they are the same.
   */
  merge(from: string, into: string): Speaker | undefined {
    if (from === into) return undefined;
    const source = this.tracks.find(candidate => candidate.speaker.id === from);
    const target = this.tracks.find(candidate => candidate.speaker.id === into);
    if (source === undefined || target === undefined) return undefined;
    if (source.centroid !== undefined) {
      target.centroid = target.centroid === undefined
        ? source.centroid
        : normalize(mix(target.centroid, target.samples, source.centroid, source.samples));
    }
    target.samples += source.samples;
    target.speaker = {
      ...target.speaker,
      lastHeardAt: Math.max(target.speaker.lastHeardAt, source.speaker.lastHeardAt),
      voiceprints: target.speaker.voiceprints + source.speaker.voiceprints,
    };
    const index = this.tracks.indexOf(source);
    if (index >= 0) this.tracks.splice(index, 1);
    return { ...target.speaker };
  }

  /** The speaker a segment vector would match, for a manual "this is me" assignment. */
  findById(speakerId: string): Speaker | undefined {
    const track = this.tracks.find(candidate => candidate.speaker.id === speakerId);
    return track === undefined ? undefined : { ...track.speaker };
  }

  private create(vector: Embedding | undefined, at: number, enrolledAs?: string): TrackedSpeaker {
    const ordinal = this.tracks.length + 1;
    const track: TrackedSpeaker = {
      speaker: {
        id: newSpeakerId(),
        name: enrolledAs ?? defaultSpeakerName(ordinal),
        named: enrolledAs !== undefined,
        voiceprints: vector === undefined ? 0 : 1,
        lastHeardAt: at,
      },
      centroid: vector,
      samples: vector === undefined ? 0 : 1,
      enrolledAs,
    };
    this.tracks.push(track);
    return track;
  }

  private absorb(track: TrackedSpeaker, vector: Embedding, at: number): void {
    track.centroid = track.centroid === undefined ? vector : normalize(blend(track.centroid, vector));
    track.samples += 1;
    track.speaker = { ...track.speaker, lastHeardAt: at, voiceprints: track.speaker.voiceprints + 1 };
  }
}

/**
 * The enrolled voiceprints, kept outside any single meeting.
 * A voiceprint turns an anonymous label into a name in every later session, which is what makes the
 * attribution useful without training the model or calling any service.
 */
export class SpeakerBook {
  private prints: Voiceprint[] = [];
  private loaded = false;

  constructor(private readonly path: string) {}

  /** Read the book from disk; a missing file is an empty book, and a corrupt one is not fatal. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as { prints?: Voiceprint[] };
      this.prints = Array.isArray(parsed.prints) ? parsed.prints.filter(isPrint) : [];
    } catch {
      this.prints = [];
    }
  }

  /** Every enrolled name. */
  names(): string[] {
    return this.prints.map(print => print.name);
  }

  /** The number of vectors stored for a name. */
  vectorCount(name: string): number {
    return this.prints.find(print => print.name === name)?.vectors.length ?? 0;
  }

  /**
   * The best enrolled match for a vector, when it is close enough.
   * @param vector - A unit voice vector.
   * @param threshold - Minimum cosine similarity.
   * @returns The matching voiceprint, or undefined.
   */
  match(vector: Embedding, threshold = DEFAULT_MATCH_THRESHOLD): Voiceprint | undefined {
    let best: Voiceprint | undefined;
    let bestScore = threshold;
    for (const print of this.prints) {
      for (const stored of print.vectors) {
        const score = cosine(vector, Float32Array.from(stored));
        if (score >= bestScore) {
          bestScore = score;
          best = print;
        }
      }
    }
    return best;
  }

  /**
   * Remember a voice under a name. Several vectors may be added to one name; the book keeps the
   * newest few so a name survives a change of microphone or distance.
   * @param name - The person's name.
   * @param embedding - A unit voice vector computed from speech of that person alone.
   * @param at - Epoch milliseconds.
   */
  async enroll(name: string, embedding: Embedding, at: number): Promise<Voiceprint> {
    await this.load();
    const vector = [...normalize(embedding)];
    const existing = this.prints.find(print => print.name === name);
    if (existing === undefined) {
      const print: Voiceprint = { name, vectors: [vector], updatedAt: at };
      this.prints.push(print);
      await this.save();
      return print;
    }
    existing.vectors = [...existing.vectors, vector].slice(-5);
    existing.updatedAt = at;
    await this.save();
    return existing;
  }

  /**
   * Drop every vector stored for a name.
   * @param name - The name to forget.
   * @returns True when something was removed.
   */
  async forget(name: string): Promise<boolean> {
    await this.load();
    const before = this.prints.length;
    this.prints = this.prints.filter(print => print.name !== name);
    if (this.prints.length === before) return false;
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify({ version: 1, prints: this.prints }, undefined, 2)}\n`, { mode: 0o600 });
  }
}

/** An attribution result, omitting `enrolledAs` unless there is a name to report. */
function attributed(speaker: Speaker, created: boolean, enrolledAs: string | undefined): Attribution {
  return { speaker: { ...speaker }, created, ...(enrolledAs === undefined ? {} : { enrolledAs }) };
}

/** A fresh speaker label id. */
export function newSpeakerId(): string {
  return `spk-${randomBytes(4).toString('hex')}`;
}

/** Blend a centroid toward a new sample. */
function blend(centroid: Embedding, vector: Embedding): Float32Array {
  const out = new Float32Array(centroid.length);
  for (let index = 0; index < centroid.length; index += 1) {
    out[index] = centroid[index]! * (1 - CENTROID_WEIGHT) + vector[index]! * CENTROID_WEIGHT;
  }
  return out;
}

/** Weighted mix of two centroids, so a merge lands between the two voices. */
function mix(left: Embedding, leftSamples: number, right: Embedding, rightSamples: number): Float32Array {
  const total = Math.max(1, leftSamples + rightSamples);
  const out = new Float32Array(Math.min(left.length, right.length));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (left[index]! * leftSamples + right[index]! * rightSamples) / total;
  }
  return out;
}

function isPrint(value: unknown): value is Voiceprint {
  const candidate = value as Partial<Voiceprint>;
  return typeof candidate?.name === 'string' && Array.isArray(candidate.vectors);
}
