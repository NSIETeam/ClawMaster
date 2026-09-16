/** Bounded file transfers and private worker lifetimes for enterprise backup and restore. */
import { fork } from 'node:child_process';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EnterpriseHostContext, EnterpriseStore } from './enterprise-host.ts';
import { GovernanceAccess, auditGovernanceOutcome } from './governance-access.ts';
import type { ExecutionIdentity } from './governance-audit.ts';
import { EnterpriseError, ENTERPRISE_BACKUP_PATH, ENTERPRISE_RESTORE_PATH } from './enterprise-types.ts';
import { enterpriseBackupConfigSchema, type EnterpriseBackupConfig } from './enterprise-backup-config.ts';
import { ENTERPRISE_BACKUP_PREPARE_PATH, preparedBackupSchema, restoreBackupRequestSchema, restoreBackupReceiptSchema,
  type PreparedEnterpriseBackup, type RestoreBackupRequest } from './enterprise-backup-format.ts';

const workerMessage = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('ready') }).strict(), z.object({ phase: z.literal('validated') }).strict(), z.object({ phase: z.literal('commitReady') }).strict(),
  z.object({ phase: z.literal('done'), result: z.unknown(), peakRssBytes: z.number().int().positive() }).strict(),
  z.object({ phase: z.literal('error'), code: z.enum(['invalid_request', 'revision_conflict', 'command_conflict', 'numeric_overflow', 'storage_invalid', 'result_too_large']) }).strict(),
]);
function owner(identity: ExecutionIdentity): string {
  return JSON.stringify([identity.organizationId, identity.actor.kind, identity.actor.id, identity.principalId ?? null]);
}
interface PreparedFile { directory: string; file: string; owner: string; summary: PreparedEnterpriseBackup; expiresAt: number; discarding?: Promise<void>; timer: ReturnType<typeof setTimeout>; }

/**
 * Register streaming backup routes with bounded files and drainable worker ownership.
 * @param ctx Authenticated DSH Fetch carrier.
 * @param store Shared database owner; it stays open until this disposer completes.
 * @param access Trusted authorization resolver.
 * @param config Deployment resource limits.
 * @param errorResponse Existing enterprise failure serializer.
 * @returns Route disposal that aborts and waits for every worker and file stream.
 */
export async function mountEnterpriseBackupRoutes(ctx: EnterpriseHostContext, store: EnterpriseStore, access: GovernanceAccess,
  config: EnterpriseBackupConfig, errorResponse: (error: unknown) => Response): Promise<() => Promise<void>> {
  const limits = enterpriseBackupConfigSchema.parse(config);
  const lifetime = new AbortController();
  const removers: Array<() => Promise<void>> = [];
  const pending = new Set<Promise<unknown>>();
  const prepared = new Map<string, PreparedFile>();
  const streams = new Set<() => Promise<void>>();
  let jobs = 0;
  let preparing = 0;
  let disposing: Promise<void> | undefined;
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  };
  const discard = async (token: string): Promise<void> => {
    const entry = prepared.get(token);
    if (!entry) return;
    await (entry.discarding ??= (async () => {
      clearTimeout(entry.timer);
      await rm(entry.directory, { recursive: true, force: true });
      prepared.delete(token);
    })());
  };
  function reserve(): () => void {
    lifetime.signal.throwIfAborted();
    if (jobs >= limits.maxConcurrentJobs) throw new EnterpriseError('storage_unavailable', 'Another backup operation is active.');
    jobs++; let released = false;
    return () => { if (!released) { released = true; jobs--; } };
  }
  async function run(mode: 'prepare' | 'export' | 'restore', file: string, signal: AbortSignal,
    phase?: (phase: 'validated' | 'commitReady') => Promise<object>, restore?: RestoreBackupRequest): Promise<unknown> {
    signal.throwIfAborted();
    const source = import.meta.url.endsWith('.ts');
    // DSH's subprocess service has no IPC channel. This fixed private entry accepts no user argv and spawns no descendants.
    const worker = fork(new NodeURL(source ? './enterprise-backup-worker.ts' : './enterprise-backup-worker.js', import.meta.url), [], {
      cwd: fileURLToPath(new NodeURL('.', import.meta.url)),
      env: Object.fromEntries(['SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [...(source ? ['--import', 'tsx/esm'] : []), `--max-old-space-size=${limits.workerHeapMb}`, `--max-semi-space-size=${limits.workerYoungHeapMb}`],
    });
    return await new Promise((resolve, reject) => {
      let result: unknown; let done = false; let ready = false; let failure: unknown;
      const stop = (error: unknown) => { failure ??= error; worker.kill('SIGKILL'); };
      const abort = () => stop(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      worker.on('error', () => { failure ??= new EnterpriseError('storage_unavailable', 'Backup process could not be started.'); });
      worker.on('message', (raw: unknown) => {
        void (async () => {
          const message = workerMessage.parse(raw);
          if (message.phase === 'ready') {
            if (ready) throw new EnterpriseError('storage_invalid', 'Duplicate backup process readiness.');
            ready = true;
            signal.throwIfAborted();
            worker.send({ mode, file, limits, ...(mode === 'export' ? { database: store.backupDatabasePath() } : {}), ...(restore ? { restore } : {}) }, error => {
              if (error) stop(new EnterpriseError('storage_unavailable', 'Backup process IPC failed.'));
            });
            return;
          }
          if (message.phase === 'error') throw new EnterpriseError(message.code, 'Backup operation could not be completed.');
          if (message.phase === 'done') { store.observeBackupProcess(mode, message.peakRssBytes); result = message.result; done = true; return; }
          if (!phase) throw new EnterpriseError('storage_invalid', 'Unexpected backup worker phase.');
          const reply = await phase(message.phase);
          if (!failure && !signal.aborted) worker.send(reply, error => { if (error) stop(new EnterpriseError('storage_unavailable', 'Backup process IPC failed.')); });
        })().catch(stop);
      });
      worker.once('close', code => {
        signal.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0 || !done) reject(new EnterpriseError('storage_unavailable', 'Backup process exited without a result or exceeded its heap limit.'));
        else resolve(result);
      });
    });
  }
  async function spool(request: Request, file: string, signal: AbortSignal, maximum: number): Promise<void> {
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new EnterpriseError('invalid_request', 'Content length is invalid.');
    if (length !== null && Number(length) > maximum) throw new EnterpriseError('result_too_large', 'Backup exceeds the configured file byte limit.');
    if (!request.body) throw new EnterpriseError('invalid_request', 'Backup body is missing.');
    const fileHandle = await open(file, 'wx', 0o600);
    const reader = request.body.getReader();
    let count = 0;
    const cancel = () => { void reader.cancel(signal.reason).catch(() => { /* The read loop reports cancellation and owns file cleanup. */ }); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        count += value.byteLength;
        if (count > maximum) throw new EnterpriseError('result_too_large', 'Backup exceeds the configured file byte limit.');
        await fileHandle.writeFile(value);
      }
      if (length !== null && count !== Number(length)) throw new EnterpriseError('invalid_request', 'Backup body length differs from its header.');
    } finally {
      signal.removeEventListener('abort', cancel);
      try { await reader.cancel(); } finally { reader.releaseLock(); await fileHandle.close(); }
    }
  }
  const route = (path: string, methods: readonly ('GET' | 'POST')[], operation: (request: Request, signal: AbortSignal) => Promise<Response>) => {
    removers.push(ctx.connection.fetch.register({ path, methods, requestBody: 'streaming', fetch: request => track((async () => {
      const signal = AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(limits.timeoutMs)]);
      signal.throwIfAborted();
      return await operation(request, signal);
    })().catch(errorResponse)) }));
  };
  try {
    route(ENTERPRISE_BACKUP_PREPARE_PATH, ['POST'], async (request, signal) => {
      const caller = await access.http(request, signal);
      return await auditGovernanceOutcome(caller, store, 'backup.prepare', undefined, async () => {
        const identity = await caller.check('backup.restore');
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new EnterpriseError('invalid_request', 'Backup upload requires application/json.');
        const release = reserve();
        let directory: string | undefined;
        let claimed = false;
        try {
          // A new upload replaces only this caller's previous staged files.
          for (const [token, entry] of prepared) if (entry.owner === owner(identity)) await discard(token);
          if (prepared.size + preparing >= limits.maxPreparedFiles) throw new EnterpriseError('storage_unavailable', 'Prepared backup capacity is full.');
          preparing++; claimed = true;
          directory = await mkdtemp(join(tmpdir(), 'clawmaster-backup-'));
          const file = join(directory, 'backup.json');
          await spool(request, file, signal, limits.maxFileBytes);
          const raw = await run('prepare', file, signal);
          const summary = preparedBackupSchema.parse({ ...z.record(z.string(), z.unknown()).parse(raw), token: randomUUID() });
          await caller.check('backup.restore'); signal.throwIfAborted();
          const timer = setTimeout(() => { void track(discard(summary.token)); }, limits.preparedTtlMs); timer.unref();
          prepared.set(summary.token, { directory, file, owner: owner(identity), summary, expiresAt: Date.now() + limits.preparedTtlMs, timer });
          directory = undefined;
          return Response.json(summary, { headers: { 'cache-control': 'no-store' } });
        } finally {
          try { if (directory) await rm(directory, { recursive: true, force: true }); } finally { if (claimed) preparing--; release(); }
        }
      }, signal);
    });
    route(ENTERPRISE_BACKUP_PATH, ['GET'], async (request, signal) => {
      const caller = await access.http(request, signal);
      return await auditGovernanceOutcome(caller, store, 'backup.export', undefined, async () => {
        let identity = await caller.check('backup.export');
        const release = reserve();
        let directory: string | undefined;
        let streaming = false;
        try {
          directory = await mkdtemp(join(tmpdir(), 'clawmaster-backup-'));
          const file = join(directory, 'backup.json');
          const raw = z.object({ bytes: z.number().int().positive(), ...preparedBackupSchema.omit({ token: true }).shape }).strict().parse(await run('export', file, signal));
          identity = await caller.check('backup.export'); signal.throwIfAborted();
          store.backupExported(identity, raw);
          const handle = await open(file, 'r');
          let closed: Promise<void> | undefined;
          const close = (): Promise<void> => closed ??= track((async () => {
            signal.removeEventListener('abort', abort); streams.delete(close);
            try { await handle.close(); await rm(directory!, { recursive: true, force: true }); } finally { release(); }
          })());
          const abort = () => { void track(close()); };
          signal.addEventListener('abort', abort, { once: true }); streams.add(close); streaming = true;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                signal.throwIfAborted();
                const buffer = Buffer.allocUnsafe(limits.chunkBytes);
                const { bytesRead } = await handle.read(buffer);
                signal.throwIfAborted();
                if (!bytesRead) { await close(); controller.close(); } else controller.enqueue(buffer.subarray(0, bytesRead));
              } catch (error) { await close(); controller.error(error); }
            }, async cancel() { await close(); },
          });
          return new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(raw.bytes), 'cache-control': 'no-store',
            'content-disposition': 'attachment; filename="clawmaster-enterprise.json"' } });
        } finally { if (!streaming) { try { if (directory) await rm(directory, { recursive: true, force: true }); } finally { release(); } } }
      }, signal);
    });
    route(ENTERPRISE_RESTORE_PATH, ['POST'], async (request, signal) => {
      const caller = await access.http(request, signal);
      await auditGovernanceOutcome(caller, store, 'backup.restore', undefined, () => caller.check('backup.restore'), signal);
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new EnterpriseError('invalid_request', 'Restore requires application/json.');
      const release = reserve();
      try {
        // The restore envelope has seven bounded scalar fields, never a backup body.
        const directory = await mkdtemp(join(tmpdir(), 'clawmaster-restore-'));
        let restore: RestoreBackupRequest;
        try {
          const file = join(directory, 'request.json');
          await spool(request, file, signal, 2048);
          const handle = await open(file, 'r');
          try { restore = restoreBackupRequestSchema.parse(JSON.parse(await handle.readFile('utf8'))); } finally { await handle.close(); }
        } finally { await rm(directory, { recursive: true, force: true }); }
        return await auditGovernanceOutcome(caller, store, 'backup.restore', restore.commandId, async () => {
          let identity = await caller.check('backup.restore');
          const replay = store.restoreReceipt(restore, identity);
          if (replay) return Response.json(replay, { headers: { 'cache-control': 'no-store' } });
          const entry = prepared.get(restore.token);
          if (!entry || entry.discarding || entry.expiresAt <= Date.now() || entry.owner !== owner(identity) || entry.summary.backupSha256 !== restore.backupSha256) throw new EnterpriseError('invalid_request', 'Prepared backup expired or belongs to another caller.');
          // Keep this file alive until the transaction exits, even if its review TTL elapses.
          clearTimeout(entry.timer); prepared.delete(restore.token);
          let restoreWriterWait: (() => void) | undefined;
          try {
            const result = await run('restore', entry.file, signal, async phase => {
              if (phase === 'validated') {
                identity = access.mode === 'enterprise' ? await caller.approve('backup.restore', '*', restore.commandId,
                  restore.expectedGeneration, restore.expectedRevision, restore.backupSha256) : await caller.check('backup.restore');
                signal.throwIfAborted();
                const current = store.overview();
                if (current.generation !== restore.expectedGeneration || current.revision !== restore.expectedRevision) throw new EnterpriseError('revision_conflict', 'Enterprise data changed during review.');
                restoreWriterWait = store.withoutWriterWait();
                return { phase: 'apply', database: store.backupDatabasePath(), identity };
              }
              await caller.check('backup.restore'); signal.throwIfAborted();
              return { phase: 'finalize' };
            }, restore);
            return Response.json(restoreBackupReceiptSchema.parse(result), { headers: { 'cache-control': 'no-store' } });
          } catch (error) {
            // A lost acknowledgement must not report cancellation after a committed transaction.
            const receipt = store.restoreReceipt(restore, identity);
            if (receipt) return Response.json(receipt, { headers: { 'cache-control': 'no-store' } });
            throw error;
          } finally { restoreWriterWait?.(); await rm(entry.directory, { recursive: true, force: true }); }
        }, signal);
      } finally { release(); }
    });
  } catch (error) {
    lifetime.abort();
    await Promise.allSettled(removers.map(remove => remove()));
    await Promise.allSettled(pending);
    await Promise.all([...prepared.keys()].map(discard));
    throw error;
  }
  return () => disposing ??= (async () => {
    lifetime.abort(new EnterpriseError('storage_unavailable', 'Backup routes are closing.'));
    const removed = await Promise.allSettled(removers.map(remove => remove()));
    await Promise.allSettled(pending);
    await Promise.allSettled([...streams].map(close => close()));
    await Promise.all([...prepared.keys()].map(discard));
    const failures = removed.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Backup routes could not be removed.');
  })();
}
