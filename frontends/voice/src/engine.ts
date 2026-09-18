/**
 * The speech engine seam.
 *
 * Recognition must be able to run against the real offline engine, against a deterministic stub in
 * tests, and against a user-chosen replacement module. The Host therefore depends on this interface
 * only, and `loadEngine` is the single place that decides which implementation is real.
 *
 * The real engine (sherpa-onnx) is an optional native dependency: when it is absent the component
 * stays healthy, reports why it cannot transcribe, and every other capability keeps working.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** One transcription result. */
export interface Transcript {
  /** The recognized text, already trimmed; an empty string means "no speech found". */
  text: string;
  /** Engine confidence in [0,1] when the engine reports one. */
  confidence?: number;
  /** The language the engine detected, when it reports one. */
  language?: string;
}

/** A unit-normalized speaker vector; two vectors are compared by cosine similarity. */
export type Embedding = Float32Array;

/** What an engine must be able to do for the component to work. */
export interface SpeechEngine {
  /** A short description of the engine and model in use, shown in the panel. */
  readonly description: string;
  /** Sample rate the engine expects; the panel and the Host resample to it. */
  readonly sampleRate: number;
  /** Transcribe one utterance of mono float samples. */
  transcribe(samples: Float32Array): Promise<Transcript>;
  /** Compute the speaker vector of the same samples, or undefined when unsupported. */
  embedding(samples: Float32Array): Promise<Embedding | undefined>;
  /** Release native resources. Safe to call more than once. */
  dispose(): void;
}

/** How an engine is built: where its model files live and how many threads it may use. */
export interface EngineOptions {
  /** Absolute directory holding the model files. */
  directory: string;
  /** Threads the native engine may use. */
  threads: number;
  /** Language hint for Whisper: 'auto' detects per segment. */
  language: string;
}

/** The engine a test may install, so no model download is needed to exercise the Host. */
export interface EngineLoader {
  (options: EngineOptions): Promise<SpeechEngine>;
}

/** Files the Whisper ASR model needs; the model directory is inspected against this list. */
export const ASR_FILES = ['whisper-encoder.onnx', 'whisper-decoder.onnx', 'whisper-tokens.txt'] as const;
/** Optional speaker-embedding model; without it every utterance is one speaker. */
export const EMBEDDING_FILES = ['speaker-embedding.onnx'] as const;

/** The environment variable that relocates the models, for an operator who stores them elsewhere. */
export const MODEL_DIRECTORY_ENV = 'CLAWMASTER_VOICE_MODELS';

/** The default model directory: outside the app bundle, because the models are large. */
export function defaultModelDirectory(home: string): string {
  return join(home, '.clawmaster', 'components', 'voice', 'models');
}

/**
 * Build the engine the component should use.
 *
 * Resolution order:
 * 1. `CLAWMASTER_VOICE_ENGINE` naming a module that exports `createEngine(options)`.
 * 2. The bundled sherpa-onnx backend, when its native module and model files are present.
 * 3. A disabled engine that reports why, so the panel can explain the state instead of failing.
 * @param options - Model directory, thread count and language hint.
 * @returns A working engine, or one whose `description` explains what is missing.
 */
export async function loadEngine(options: EngineOptions): Promise<SpeechEngine> {
  const override = process.env.CLAWMASTER_VOICE_ENGINE;
  if (override !== undefined && override.trim() !== '') {
    const module = await import(override) as { createEngine?: EngineLoader };
    if (typeof module.createEngine !== 'function') {
      throw new Error(`Voice engine module ${override} does not export createEngine().`);
    }
    return module.createEngine(options);
  }
  return createSherpaEngine(options);
}

/** List the model files that are installed, so the panel can show what is ready. */
export function inspectModels(directory: string): { installed: Array<{ name: string; bytes: number }>; missing: string[] } {
  const installed: Array<{ name: string; bytes: number }> = [];
  const missing: string[] = [];
  for (const name of [...ASR_FILES, ...EMBEDDING_FILES]) {
    const path = join(directory, name);
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    const { size } = statSize(path);
    installed.push({ name, bytes: size });
  }
  return { installed, missing };
}

/**
 * The model directory a component instance should use.
 * Precedence: the configured path, then the environment override, then the default under the user's
 * home. The environment step exists so the models can live on a bigger volume without a code change,
 * and so a test can point the real engine at the real files.
 * @param configured - The profile's `modelDirectory`, when it set one.
 * @param home - The user's home directory.
 * @param environment - The process environment, injected for tests.
 */
export function resolveModelDirectory(configured: string | undefined, home: string, environment = process.env): string {
  if (configured !== undefined) return configured;
  const override = environment[MODEL_DIRECTORY_ENV];
  return override !== undefined && override.trim() !== '' ? override : defaultModelDirectory(home);
}

/** An engine that cannot transcribe, carrying the reason as its description. */
export function unavailableEngine(reason: string, sampleRate: number): SpeechEngine {
  return {
    description: `unavailable: ${reason}`,
    sampleRate,
    transcribe: () => Promise.resolve({ text: '' }),
    embedding: () => Promise.resolve(undefined),
    dispose: () => undefined,
  };
}

function statSize(path: string): { size: number } {
  return { size: statSync(path).size };
}

/** True when the directory exists and has at least the ASR model, so a first run can be short. */
export function modelsReady(directory: string): boolean {
  if (!existsSync(directory)) return false;
  const names = new Set(readdirSync(directory));
  return ASR_FILES.every(name => names.has(name));
}

/**
 * The real engine: sherpa-onnx offline Whisper recognition plus speaker embedding.
 * The native module is loaded lazily and its absence is a reported state, never a crash.
 */
async function createSherpaEngine(options: EngineOptions): Promise<SpeechEngine> {
  const engineUnavailable = (reason: string) => unavailableEngine(reason, 16_000);
  if (!existsSync(options.directory)) {
    return engineUnavailable(`model directory ${options.directory} does not exist`);
  }
  const { installed, missing } = inspectModels(options.directory);
  const hasAsr = ASR_FILES.every(name => installed.some(entry => entry.name === name));
  if (!hasAsr) return engineUnavailable(`missing model files: ${missing.join(', ')}`);
  let sherpa: SherpaModule;
  try {
    sherpa = await importSherpa();
  } catch (error) {
    return engineUnavailable(`sherpa-onnx-node is not installed (${messageOf(error)})`);
  }
  const recognizer = createRecognizer(sherpa, options);
  if (recognizer === undefined) return engineUnavailable('the offline Whisper recognizer could not be created');
  const extractor = createEmbeddingExtractor(sherpa, options);
  let disposed = false;
  return {
    description: `sherpa-onnx Whisper (${isAutoLanguage(options.language) ? 'auto' : options.language})`,
    sampleRate: 16_000,
    async transcribe(samples) {
      if (disposed) return { text: '' };
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16_000 });
      // The asynchronous decoder runs on libuv's pool; the synchronous one would block the Host for
      // the whole decode, which for a 20-second utterance is seconds of a frozen agent loop.
      const result = await recognizer.decodeAsync(stream);
      return { text: typeof result.text === 'string' ? result.text.trim() : '' };
    },
    embedding(samples) {
      if (disposed || extractor === undefined) return Promise.resolve(undefined);
      try {
        const stream = extractor.createStream();
        stream.acceptWaveform({ samples, sampleRate: 16_000 });
        if (!extractor.isReady(stream)) return Promise.resolve(undefined);
        return Promise.resolve(normalize(Float32Array.from(extractor.compute(stream))));
      } catch {
        // A segment too short to embed is a normal event, not a failure of the segment.
        return Promise.resolve(undefined);
      }
    },
    dispose() {
      // sherpa handles are Napi::External objects finalized by the collector; there is no free().
      disposed = true;
    },
  };
}

/**
 * Load sherpa-onnx-node, whose published main is CommonJS.
 * The package's namespace therefore carries its real exports on `default`, and reading only the
 * namespace would silently see two names instead of the twenty the library publishes.
 */
async function importSherpa(): Promise<SherpaModule> {
  const namespace = await import('sherpa-onnx-node') as unknown as SherpaModule & { default?: SherpaModule };
  return Object.assign({}, namespace, namespace.default ?? {}) as SherpaModule;
}

/** True when the caller asked for detection rather than naming a language. */
export function isAutoLanguage(language: string): boolean {
  const value = language.trim().toLowerCase();
  return value === '' || value === 'auto';
}

/** The parts of the sherpa-onnx-node surface this component uses. */
interface SherpaModule {
  OfflineRecognizer: SherpaRecognizerConstructor;
  SpeakerEmbeddingExtractor?: new (config: { model: string; numThreads?: number; debug?: boolean | number; provider?: string }) => EmbeddingExtractor;
  version?: string;
}

interface SherpaRecognizerConstructor {
  new (config: unknown): OfflineRecognizer;
  /** Build the recognizer without blocking the event loop while the model loads. */
  createAsync?(config: unknown): Promise<OfflineRecognizer>;
}

interface OfflineRecognizer {
  createStream(): RecognizerStream;
  decode(stream: RecognizerStream): void;
  decodeAsync(stream: RecognizerStream): Promise<{ text?: string; lang?: string }>;
}

interface RecognizerStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
}

interface EmbeddingExtractor {
  createStream(): RecognizerStream;
  isReady(stream: RecognizerStream): boolean;
  compute(stream: RecognizerStream): Float32Array | number[];
}

function createRecognizer(sherpa: SherpaModule, options: EngineOptions): OfflineRecognizer | undefined {
  if (sherpa.OfflineRecognizer === undefined) return undefined;
  const directory = options.directory;
  const config = {
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: join(directory, 'whisper-encoder.onnx'),
        decoder: join(directory, 'whisper-decoder.onnx'),
        // The native decoder rejects the literal 'auto': omitting the language is what asks Whisper
        // to detect it, which is why the default config never passes the word through.
        ...(isAutoLanguage(options.language) ? {} : { language: options.language }),
        task: 'transcribe',
      },
      tokens: join(directory, 'whisper-tokens.txt'),
      numThreads: options.threads,
      provider: 'cpu',
      debug: 0,
    },
  };
  try {
    return new sherpa.OfflineRecognizer(config);
  } catch {
    return undefined;
  }
}

function createEmbeddingExtractor(sherpa: SherpaModule, options: EngineOptions): EmbeddingExtractor | undefined {
  const path = join(options.directory, 'speaker-embedding.onnx');
  if (!existsSync(path)) return undefined;
  const Constructor = sherpa.SpeakerEmbeddingExtractor;
  if (Constructor === undefined) return undefined;
  try {
    return new Constructor({ model: path, numThreads: options.threads, debug: 0, provider: 'cpu' });
  } catch {
    return undefined;
  }
}

/** Scale a vector to unit length so cosine similarity is a plain dot product. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (length === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index]! / length;
  return out;
}

/** Cosine similarity of two unit vectors. */
export function cosine(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += left[index]! * right[index]!;
  return sum;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
