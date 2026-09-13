/**
 * Vault change detection for live refresh.
 *
 * Combines a filesystem fingerprint with a recursive watcher so a reader learns both the
 * state at startup and every later external edit (an editor or the agent writing files).
 * The fingerprint is the authority: a watcher event only schedules a re-fingerprint, so a
 * missed, coalesced or unsupported watch event degrades to a slower refresh, never a stale view.
 *
 * That degradation is enforced here rather than left to the caller: a safety poll re-fingerprints
 * on an interval, so an event that never arrives (macOS FSEvents occasionally drops one under
 * load — observed once in this module's own suite) costs latency, not correctness. Events remain
 * the accelerator; the poll is the floor.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { NOTE_EXTENSIONS } from './vault.ts';

/** Coalescing window for a burst of filesystem events. */
const DEBOUNCE_MS = 120;

/**
 * How often the safety poll re-fingerprints when no event arrives.
 *
 * A fingerprint walk is one readdir per directory plus one stat per note file — microseconds for
 * a personal vault — and the same work the `/revision` route already performs on demand, so this
 * adds one bounded sweep rather than a new class of load.
 */
const FALLBACK_POLL_MS = 3000;

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

/** Watch one vault root and publish a new version whenever its note files change. */
export class VaultWatcher {
  private version: string;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private disposed = false;
  private computing: Promise<string> | undefined;
  private closing: Promise<void> | undefined;
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
    // The floor under the accelerator, attached whether or not the watch succeeded: an
    // unsupported watch platform and a dropped event both degrade to this interval.
    this.poll = setInterval(() => { this.refresh(); }, FALLBACK_POLL_MS);
    this.poll.unref();
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.refresh(); }, DEBOUNCE_MS);
    this.timer.unref();
  }

  private refresh(): void {
    void this.recompute().catch(error => { this.failure = error instanceof Error ? error.message : String(error); });
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

  /** The current vault version. */
  current(): string {
    return this.version;
  }

  /** Whether filesystem events are attached; false means refresh depends on polling alone. */
  get active(): boolean {
    return this.watcher !== undefined;
  }

  /** Latest watch-attachment or background-scan failure, when one occurred. */
  get unavailableReason(): string | undefined {
    return this.failure;
  }

  /** Stop notifications and wait for any active scan. Idempotent. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    // The query caller or background refresh owns scan errors; teardown only waits.
    this.closing = (this.computing ?? Promise.resolve(this.version)).then(() => undefined, () => undefined);
    return this.closing;
  }
}
