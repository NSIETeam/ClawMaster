/**
 * Fetching the optional runtime.
 *
 * This is 270 MiB of Java, and the only route that works from this machine is a GitHub proxy that has
 * been measured truncating large files while still answering HTTP 200. So the rules are strict:
 *
 * - The manifest pins an exact size and sha256, taken from the upstream release metadata rather than
 *   typed by hand.
 * - A download is verified before it is moved into place, and a mismatch is deleted and retried, so a
 *   truncated jar can never look installed.
 * - Nothing here runs the runtime; `fetchRuntime` only puts files on disk.
 *
 * `--archive` accepts an already downloaded archive, because a user on a worse network should not have
 * to fight the proxy twice.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** Where the optional runtime lives when nothing else is configured. */
export function defaultRuntimeDirectory(home = homedir()): string {
  return join(home, '.clawmaster', 'components', 'pdf', 'runtime');
}

/** One artifact of the optional runtime. */
export interface RuntimeArtifact {
  /** The file name it is installed as. */
  name: string;
  /** Exact byte count upstream published. */
  bytes: number;
  /** sha256 upstream published. */
  sha256: string;
  /** What it is, for the log line. */
  role: string;
  /** Download URLs, tried in order. */
  sources: readonly string[];
  /** Where the upstream checksum came from, so the pin can be re-verified later. */
  checksumSource: string;
}

/**
 * The pinned set, measured on 2026-09-14.
 *
 * Both from GitHub's own release metadata: the Stirling asset carries a `sha256:` digest, and Adoptium's
 * API publishes the JRE checksum. The proxy prefix is the only route that delivers bytes here; direct
 * github.com answers nothing.
 */
export const RUNTIME_ARTIFACTS: readonly RuntimeArtifact[] = [
  {
    name: 'Stirling-PDF-server.jar',
    bytes: 234_348_075,
    sha256: '3399432a5d81793141addb14f3436ed0544d837eb57fc42be8ea8ab6df63a4a2',
    role: 'Stirling-PDF server (v2.14.3)',
    sources: ['https://ghproxy.net/https://github.com/Stirling-Tools/Stirling-PDF/releases/download/v2.14.3/Stirling-PDF-server.jar'],
    checksumSource: 'GitHub release asset digest for v2.14.3',
  },
  {
    name: 'OpenJDK21U-jre_aarch64_mac_hotspot_21.0.12.1_1.tar.gz',
    bytes: 48_144_965,
    sha256: 'dec50fc6f9fcd4fe3ae8cabf5a5fa68f6afc48841f7698e468e9aa5d54beed84',
    role: 'Temurin 21 JRE for macOS arm64, to be extracted',
    sources: ['https://ghproxy.net/https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.12.1_1.tar.gz'],
    checksumSource: "adoptium.net v3 assets API (image_type=jre, os=mac, architecture=aarch64)",
  },
];

/**
 * The slice of the filesystem the fetcher uses.
 *
 * Hashing belongs to this interface, not beside it: verification is the step that decides whether a
 * download is installed, so an injected filesystem that could not hash would verify against a
 * different filesystem than the one it wrote to.
 */
export interface FetchFs {
  exists(path: string): boolean;
  remove(path: string): void;
  rename(from: string, to: string): void;
  mkdir(path: string): void;
  size(path: string): number;
  sha256(path: string): Promise<string>;
}

/** The default filesystem. */
export const nodeFetchFs: FetchFs = {
  exists: path => existsSync(path),
  remove: path => rmSync(path, { force: true }),
  rename: (from, to) => renameSync(from, to),
  mkdir: path => { mkdirSync(path, { recursive: true }); },
  size: path => statSync(path).size,
  sha256: path => sha256Of(path),
};

/** How a fetch behaves. */
export interface FetchRuntimeOptions {
  /** Where the runtime is installed. */
  directory: string;
  /** Which artifacts to fetch; defaults to all of them. */
  artifacts?: readonly RuntimeArtifact[];
  /** How many times a source may be tried before giving up. */
  attempts?: number;
  /** Filesystem, for a test. */
  fs?: FetchFs;
  /** Download one URL to a path, returning the bytes written. Injected so a test needs no network. */
  download: (url: string, destination: string) => Promise<number>;
  /** Called after each attempt, so a caller can show progress. */
  onProgress?: (message: string) => void;
}

/** What a fetch produced. */
export interface FetchRuntimeResult {
  directory: string;
  installed: Array<{ name: string; bytes: number }>;
  /** Artifacts that were already present and verified. */
  alreadyPresent: string[];
  /** Artifacts that could not be fetched or verified, with the last reason. */
  failed: Array<{ name: string; reason: string }>;
}

/**
 * Download and verify the optional runtime.
 * @param options - Where to install, which artifacts, and how to download.
 * @returns What is now on disk and what could not be fetched.
 */
export async function fetchRuntime(options: FetchRuntimeOptions): Promise<FetchRuntimeResult> {
  const fs = options.fs ?? nodeFetchFs;
  const wanted = options.artifacts ?? RUNTIME_ARTIFACTS;
  const attempts = Math.max(1, options.attempts ?? 2);
  const directory = options.directory;
  const result: FetchRuntimeResult = { directory, installed: [], alreadyPresent: [], failed: [] };
  fs.mkdir(directory);

  for (const artifact of wanted) {
    const target = join(directory, artifact.name);
    if (fs.exists(target) && fs.size(target) === artifact.bytes && await fs.sha256(target) === artifact.sha256) {
      options.onProgress?.(`${artifact.name} is already installed and verified`);
      result.alreadyPresent.push(artifact.name);
      continue;
    }
    let reason = 'no source was tried';
    let done = false;
    for (let attempt = 1; attempt <= attempts && !done; attempt += 1) {
      for (const source of artifact.sources) {
        const partial = `${target}.part`;
        try {
          options.onProgress?.(`${artifact.name}: attempt ${attempt} from ${hostOf(source)}`);
          const written = await options.download(source, partial);
          if (written !== artifact.bytes) throw new Error(`truncated: ${written} of ${artifact.bytes} bytes`);
          const digest = await fs.sha256(partial);
          if (digest !== artifact.sha256) throw new Error(`sha256 ${digest.slice(0, 12)}… does not match ${artifact.sha256.slice(0, 12)}…`);
          fs.rename(partial, target);
          result.installed.push({ name: artifact.name, bytes: artifact.bytes });
          options.onProgress?.(`${artifact.name}: installed and verified`);
          done = true;
          break;
        } catch (error) {
          reason = messageOf(error);
          // A failed or mismatched download must not be left where the supervisor could launch it.
          fs.remove(partial);
          options.onProgress?.(`${artifact.name}: ${reason}`);
        }
      }
    }
    if (!done) result.failed.push({ name: artifact.name, reason });
  }
  return result;
}

/** True when every artifact is installed, the right size, and the right bytes. */
export async function runtimeInstalled(directory: string, artifacts: readonly RuntimeArtifact[] = RUNTIME_ARTIFACTS): Promise<boolean> {
  for (const artifact of artifacts) {
    const path = join(directory, artifact.name);
    if (!existsSync(path) || statSync(path).size !== artifact.bytes) return false;
    if (await sha256Of(path) !== artifact.sha256) return false;
  }
  return true;
}

/** sha256 of a file, streamed so a 234 MiB jar does not have to fit in memory. */
export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** The default downloader, streaming to disk so a large artifact never lands in memory. */
export async function downloadToFile(url: string, destination: string): Promise<number> {
  mkdirSync(dirname(destination), { recursive: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
  let written = 0;
  await pipeline(
    response.body as unknown as AsyncIterable<Uint8Array>,
    async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        written += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(destination),
  );
  return written;
}

/** A reason for a failure that the log line can show. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host of a URL, for a log line that does not print a signed query string. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
