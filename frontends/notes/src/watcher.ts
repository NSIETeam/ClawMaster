/**
 * Vault change detection for live refresh.
 *
 * Combines a filesystem fingerprint with a recursive watcher so a reader learns both the
 * state at startup and every later external edit (an editor or the agent writing files).
 * The fingerprint is the authority: a watcher event only schedules a re-fingerprint, so a
 * missed, coalesced or unsupported watch event degrades to a slower refresh, never a stale view.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { NOTE_EXTENSIONS } from './vault.ts';

/** Coalescing window for a burst of filesystem events. */
const DEBOUNCE_MS = 120;

/** True when a vault-relative path is hidden or belongs to tooling rather than the user. */
export function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(segment => segment.startsWith('.'));
}

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
    catch { return; }
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile()) continue;
      if (!NOTE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) continue;
      const info = await stat(absolute);
      parts.push(`${absolute}:${info.size}:${info.mtimeMs}`);
    }
  };
  await walk(root);
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** Watch one vault root and publish a new version whenever its note files change. */
export class VaultWatcher {
  private version: string;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  /** Why the filesystem watcher could not be attached, when it could not. */
  private failure: string | undefined;

  private constructor(readonly root: string, version: string) {
    this.version = version;
  }

  /** Fingerprint the vault and start watching it. */
  static async open(root: string): Promise<VaultWatcher> {
    const watcher = new VaultWatcher(root, await fingerprint(root));
    watcher.start();
    return watcher;
  }

  private start(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (typeof filename === 'string' && isIgnoredPath(filename)) return;
        this.schedule();
      });
      // A failed watch is not fatal — `recompute` remains the authority — but it is recorded
      // rather than swallowed, so a caller can tell live events from poll-only refresh.
      this.watcher.on('error', error => { this.failure = error.message; this.watcher?.close(); this.watcher = undefined; });
    } catch (error) {
      this.failure = (error as Error).message;
      this.watcher = undefined;
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.recompute(); }, DEBOUNCE_MS);
    this.timer.unref();
  }

  /** Re-fingerprint now; exposed so a caller can refresh without waiting for an event. */
  async recompute(): Promise<string> {
    if (this.disposed) return this.version;
    this.version = await fingerprint(this.root);
    return this.version;
  }

  /** The current vault version. */
  current(): string {
    return this.version;
  }

  /** Whether filesystem events are attached; false means refresh depends on polling alone. */
  get active(): boolean {
    return this.watcher !== undefined;
  }

  /** Why the filesystem watcher is not attached, when it is not. */
  get unavailableReason(): string | undefined {
    return this.failure;
  }

  /** Stop watching. Idempotent. */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }
}
