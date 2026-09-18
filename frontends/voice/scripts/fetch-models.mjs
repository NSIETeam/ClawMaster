#!/usr/bin/env node
/**
 * Fetch the speech models the Voice component needs.
 *
 * Why a script and not a bundled asset: the full set is about 190 MiB, which does not belong in an
 * installer that most users will never record a meeting with. Why the hash checks are not optional:
 * measured on 2026-09-14, `ghproxy.net` served a **truncated** 83 MB of a 116 MB archive while still
 * answering HTTP 200, and a truncated ONNX file fails deep inside the native engine with an unrelated
 * message. A size and sha256 check turns that into a clear retry against another mirror.
 *
 * Usage:
 *   node scripts/fetch-models.mjs                 # the default set: dictation + speaker separation
 *   node scripts/fetch-models.mjs --all           # add the VAD and diarization models
 *   node scripts/fetch-models.mjs --dir /path     # install somewhere other than the default
 *   node scripts/fetch-models.mjs --check         # report what is installed, download nothing
 *   node scripts/fetch-models.mjs --only whisper-tokens.txt   # one file, for a bounded test
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pipeline } = require('node:stream/promises');

/**
 * One model file: where it comes from, how big it is, and what makes it the right bytes.
 *
 * Sources are tried in order and every one of them is verified by size and sha256 before it is
 * accepted. Two mirrors are listed per file because neither is dependable on its own: measured on
 * 2026-09-14, `ghproxy.net` truncated a 116 MB archive to 83 MB while answering HTTP 200, while
 * `hf-mirror.com` serves small files directly but redirects large ones to a blocked CDN — so a file
 * that is small goes to the mirror and a file that is large goes to ModelScope first.
 */
const MODELS = [
  {
    name: 'whisper-encoder.onnx',
    bytes: 37_647_080,
    sha256: '42c1d4cbf889632ba21ab6f0d4064c80209755f265ce5cd630db4a6793e7089c',
    role: 'Whisper encoder (multilingual, tiny)',
    sources: [
      'https://modelscope.cn/api/v1/models/pengzhendong/sherpa-onnx-whisper-tiny/repo?Revision=master&FilePath=tiny-encoder.onnx',
      'https://hf-mirror.com/csukuangfj/sherpa-onnx-whisper-tiny/resolve/main/tiny-encoder.onnx',
    ],
  },
  {
    name: 'whisper-decoder.onnx',
    bytes: 114_505_801,
    sha256: 'e144c07dc6b55cece24392811f2d934b97013811f5e677d1315d341a0a74a25d',
    role: 'Whisper decoder (multilingual, tiny)',
    sources: [
      'https://modelscope.cn/api/v1/models/pengzhendong/sherpa-onnx-whisper-tiny/repo?Revision=master&FilePath=tiny-decoder.onnx',
      'https://hf-mirror.com/csukuangfj/sherpa-onnx-whisper-tiny/resolve/main/tiny-decoder.onnx',
    ],
  },
  {
    name: 'whisper-tokens.txt',
    bytes: 816_730,
    sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
    role: 'Whisper token table',
    sources: [
      'https://modelscope.cn/api/v1/models/pengzhendong/sherpa-onnx-whisper-tiny/repo?Revision=master&FilePath=tiny-tokens.txt',
      'https://hf-mirror.com/csukuangfj/sherpa-onnx-whisper-tiny/resolve/main/tiny-tokens.txt',
    ],
  },
  {
    name: 'speaker-embedding.onnx',
    bytes: 39_593_761,
    sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
    role: 'Speaker voiceprints (3D-Speaker ERes2Net, zh-CN, 16 kHz, 512-dim)',
    optional: false,
    sources: [
      'https://modelscope.cn/api/v1/models/zyaztec/sherpa-onnx-3dspeaker-eres2net-base-sv-zh-cn/repo?Revision=master&FilePath=3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
      'https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
    ],
  },
  {
    name: 'silero-vad.onnx',
    bytes: 643_854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    role: 'Silero VAD (not used yet: endpointing is energy-based)',
    optional: true,
    sources: [
      'https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    ],
  },
];

/** The directory the running component reads, matching `defaultModelDirectory` in src/engine.ts. */
function defaultDirectory() {
  return join(homedir(), '.clawmaster', 'components', 'voice', 'models');
}

/** Parse the few flags this script has. */
function parseArgs(argv) {
  const options = { directory: defaultDirectory(), all: false, check: false, force: false, only: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--all') options.all = true;
    else if (flag === '--check') options.check = true;
    else if (flag === '--force') options.force = true;
    else if (flag === '--only') {
      const next = argv[index + 1];
      if (next === undefined) throw new Error('--only needs a model file name.');
      options.only.push(next);
      index += 1;
    }
    else if (flag === '--dir') {
      const next = argv[index + 1];
      if (next === undefined) throw new Error('--dir needs a path.');
      options.directory = next.startsWith('/') ? next : join(process.cwd(), next);
      index += 1;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

/** sha256 of a file on disk, streamed so a 115 MB decoder does not have to fit in memory. */
async function sha256Of(path) {
  const { createReadStream } = require('node:fs');
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Whether the file on disk is exactly the expected bytes, by size and by hash. */
async function isCurrent(model, directory) {
  const path = join(directory, model.name);
  if (!existsSync(path)) return false;
  if (statSync(path).size !== model.bytes) return false;
  return await sha256Of(path) === model.sha256;
}

/** Download one URL to a temporary path, returning what actually arrived. */
async function download(url, destination, expectedBytes) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
  const partial = `${destination}.part`;
  const hash = createHash('sha256');
  let received = 0;
  const file = createWriteStream(partial);
  const source = response.body;
  let failure;
  try {
    await pipeline(source, async function* (chunks) {
      for await (const chunk of chunks) {
        received += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    }, file);
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    rmSync(partial, { force: true });
    throw failure;
  }
  if (received !== expectedBytes) {
    rmSync(partial, { force: true });
    throw new Error(`truncated: received ${received} of ${expectedBytes} bytes`);
  }
  return { partial, sha256: hash.digest('hex') };
}

/** Fetch one model, trying each source until the bytes verify. */
async function fetchModel(model, directory) {
  const failures = [];
  for (const source of model.sources) {
    // A `#name` suffix means the source is an archive: skipped here, because the archives are the
    // reason this script exists (they truncate) and the mirrors serve the extracted files.
    if (source.includes('#')) {
      failures.push(`${hostOf(source)} (archive source, not used)`);
      continue;
    }
    try {
      process.stdout.write(`  ${hostOf(source)} … `);
      const { partial, sha256 } = await download(source, join(directory, model.name), model.bytes);
      if (sha256 !== model.sha256) {
        rmSync(partial, { force: true });
        throw new Error(`sha256 ${sha256.slice(0, 12)}… does not match ${model.sha256.slice(0, 12)}…`);
      }
      renameSync(partial, join(directory, model.name));
      process.stdout.write('ok\n');
      return true;
    } catch (error) {
      process.stdout.write(`failed (${error instanceof Error ? error.message : String(error)})\n`);
      failures.push(`${hostOf(source)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.error(`  ${model.name}: every source failed`);
  for (const failure of failures) console.error(`    - ${failure}`);
  return false;
}

/** The host of a source URL, for a log line that does not print a signed query string. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Human-readable mebibytes. */
function mib(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

/** The models this run should ensure, given `--all`. */
function selected(options) {
  if (options.only.length > 0) {
    const wanted = MODELS.filter(model => options.only.includes(model.name));
    for (const name of options.only) {
      if (!wanted.some(model => model.name === name)) throw new Error(`Unknown model: ${name}`);
    }
    return wanted;
  }
  return MODELS.filter(model => options.all || model.optional !== true);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const wanted = selected(options);
  const total = wanted.reduce((sum, model) => sum + model.bytes, 0);
  console.log(`Voice models → ${options.directory}`);
  console.log(`${wanted.length} files, ${mib(total)}${options.all ? ' (including optional)' : ''}`);

  const status = [];
  for (const model of wanted) {
    const current = await isCurrent(model, options.directory);
    status.push({ model, current });
    console.log(`${current ? 'ok  ' : 'need'} ${model.name.padEnd(28)} ${mib(model.bytes).padStart(10)}  ${model.role}`);
  }
  if (options.check) {
    const missing = status.filter(entry => !entry.current);
    console.log(missing.length === 0 ? 'all selected models are installed and verified.' : `${missing.length} model(s) missing.`);
    process.exitCode = missing.length === 0 ? 0 : 1;
    return;
  }

  const todo = status.filter(entry => !entry.current || options.force);
  if (todo.length === 0) {
    console.log('nothing to download: every selected model is installed and verified.');
    return;
  }
  mkdirSync(options.directory, { recursive: true });
  let failed = 0;
  for (const entry of todo) {
    console.log(`fetching ${entry.model.name} (${mib(entry.model.bytes)})`);
    if (!await fetchModel(entry.model, options.directory)) failed += 1;
  }
  if (failed > 0) {
    console.error(`${failed} model(s) could not be verified. Nothing was left half-written.`);
    process.exitCode = 1;
    return;
  }
  // Verify what is now on disk rather than trusting the download path.
  for (const model of wanted) {
    if (!await isCurrent(model, options.directory)) {
      console.error(`${model.name} does not verify after download.`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`installed and verified ${wanted.length} files in ${options.directory}`);
}

// Only run when invoked directly, so a test can import the manifest and helpers.
const invokedDirectly = process.argv[1] !== undefined && dirname(process.argv[1]) === dirname(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { MODELS, defaultDirectory, hostOf, isCurrent, selected };
