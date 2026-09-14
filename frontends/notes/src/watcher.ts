/** On-demand note fingerprints shared by concurrent revision requests. */
import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { NOTE_EXTENSIONS } from './vault.ts';


/**
 * Fingerprint the note files under a root.
 * Uses size and mtime rather than content, so a same-size write inside the same millisecond
 * is the one change this cannot see; every other edit moves the fingerprint.
 */
export async function fingerprint(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile()) continue;
      if (!NOTE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) continue;
      let info;
      try { info = await stat(absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      parts.push(`${absolute}:${info.size}:${info.mtimeMs}`);
    }
  };
  await walk(root);
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** Coalesce revision scans and await their completion when the Notes plugin unloads. */
export class VaultWatcher {
  private version: string;
  private disposed = false;
  private computing: Promise<string> | undefined;
  private closing: Promise<void> | undefined;

  private constructor(readonly root: string, version: string) {
    this.version = version;
  }

  /** Read the initial version; subsequent scans are requested by the revision route. */
  static async open(root: string): Promise<VaultWatcher> {
    return new VaultWatcher(root, await fingerprint(root));
  }

  /** Re-fingerprint now, sharing an in-flight scan with other callers. */
  recompute(): Promise<string> {
    if (this.disposed) return Promise.resolve(this.version);
    if (this.computing) return this.computing;
    const operation = fingerprint(this.root).then(version => {
      if (!this.disposed) this.version = version;
      return this.version;
    });
    this.computing = operation;
    const settled = (): void => { if (this.computing === operation) this.computing = undefined; };
    void operation.then(settled, settled);
    return operation;
  }

  /** Stop accepting scans and wait for an active scan. Idempotent. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    // The revision request owns scan errors; teardown only waits.
    this.closing = (this.computing ?? Promise.resolve(this.version)).then(() => undefined, () => undefined);
    return this.closing;
  }
}
