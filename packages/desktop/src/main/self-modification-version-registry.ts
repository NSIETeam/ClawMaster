import { createHash } from 'node:crypto';
import {
  cp, lstat, mkdir, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { SelfModificationDependencies } from './self-modification-controller.js';

type AtomicUpdater = SelfModificationDependencies['updater'];

interface CandidateFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SelfModificationCandidateManifest {
  schemaVersion: 1;
  version: string;
  sourceCommit: string;
  minimumVersion: string;
  signingKeyId: string;
  signature: string;
  files: CandidateFile[];
}

export type CandidateSignatureVerifier = (
  canonicalPayload: Buffer,
  signature: string,
  signingKeyId: string,
) => Promise<boolean>;

const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function assertSafeVersion(version: string): void {
  if (!SAFE_VERSION.test(version)) throw new Error('candidate version must be a safe version');
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

export function candidateSignaturePayload(manifest: SelfModificationCandidateManifest): Buffer {
  const { signature: _signature, ...unsigned } = manifest;
  return Buffer.from(JSON.stringify(stable(unsigned)));
}

function safeRelativeFile(candidate: string): boolean {
  if (!candidate || path.isAbsolute(candidate)) return false;
  const normalized = path.normalize(candidate);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

async function hash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export class SignedSelfModificationVersionRegistry implements AtomicUpdater {
  constructor(private readonly options: {
    root: string;
    verifySignature: CandidateSignatureVerifier;
  }) {}

  async activate(candidateDirectory: string) {
    const previousVersion = await this.activeVersion();
    try {
      const manifest = await this.verifyDirectory(candidateDirectory);
      const versions = path.join(this.options.root, 'versions');
      const destination = path.join(versions, manifest.version);
      const temporary = path.join(versions, `.${manifest.version}.${process.pid}.tmp`);
      await mkdir(versions, { recursive: true, mode: 0o700 });
      await rm(temporary, { recursive: true, force: true });
      await cp(candidateDirectory, temporary, { recursive: true, errorOnExist: true, force: false });
      await this.verifyDirectory(temporary);
      await rename(temporary, destination).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
        await rm(temporary, { recursive: true, force: true });
        await this.verifyDirectory(destination);
      });
      await this.writeActive(manifest.version, manifest.sourceCommit);
      return { ok: true as const, previousVersion };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
        previousVersion,
        requiresRollback: false,
      };
    }
  }

  async rollback(version: string): Promise<void> {
    assertSafeVersion(version);
    const directory = path.join(this.options.root, 'versions', version);
    const manifest = await this.verifyDirectory(directory);
    await this.writeActive(manifest.version, manifest.sourceCommit);
  }

  private async activeVersion(): Promise<string> {
    try {
      const active = JSON.parse(await readFile(path.join(this.options.root, 'active.json'), 'utf8')) as { version?: string };
      if (!active.version) return 'none';
      assertSafeVersion(active.version);
      return active.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
      throw error;
    }
  }

  private async writeActive(version: string, sourceCommit: string): Promise<void> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.options.root, 'active.json');
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version, sourceCommit })}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  private async verifyDirectory(directory: string): Promise<SelfModificationCandidateManifest> {
    const raw = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as SelfModificationCandidateManifest;
    if (raw.schemaVersion !== 1) throw new Error('unsupported candidate manifest schema');
    assertSafeVersion(raw.version);
    if (!/^[a-f0-9]{40}$/u.test(raw.sourceCommit)) throw new Error('candidate source commit is invalid');
    if (!raw.signingKeyId?.trim() || !raw.signature?.trim()) throw new Error('candidate signature identity is incomplete');
    if (!Array.isArray(raw.files) || raw.files.length === 0) throw new Error('candidate manifest contains no files');
    const unique = new Set<string>();
    for (const entry of raw.files) {
      if (!safeRelativeFile(entry.path) || unique.has(entry.path)) throw new Error('candidate contains an unsafe or duplicate path');
      unique.add(entry.path);
      if (!SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        throw new Error('candidate file evidence is invalid');
      }
      const file = path.join(directory, entry.path);
      const metadata = await lstat(file);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('candidate files must be regular files');
      if ((await stat(file)).size !== entry.bytes || await hash(file) !== entry.sha256) {
        throw new Error(`candidate file hash or size mismatch: ${entry.path}`);
      }
    }
    if (!await this.options.verifySignature(candidateSignaturePayload(raw), raw.signature, raw.signingKeyId)) {
      throw new Error('candidate signature is invalid');
    }
    return raw;
  }
}
