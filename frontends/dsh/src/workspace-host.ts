/** Lazily allocate DSH Workspaces under the product-owned directory. */
import { randomUUID } from 'node:crypto';
import { mkdir, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { EnterpriseHostContext } from './enterprise-host.ts';
import { GovernanceAccess, GovernanceDenied, governanceResource } from './governance-access.ts';

export interface WorkspaceHostContext extends EnterpriseHostContext {
  workspaceRegistry: {
    create(path: string, title?: string): Promise<{ id: string; path: string }>;
    get(id: string): { sessionIds: readonly string[] } | undefined;
  };
}

/**
 * Register an allocation route that checks current identity and workspace-kind permission before creating directories and registering a Workspace.
 * @param ctx - DSH workspace and authenticated Fetch services.
 * @param managedRoot - Absolute directory owned by this product.
 * @param access - Shared local or enterprise authorization used by business operations.
 * @returns Idempotent disposer that withdraws the route and drains admitted work; allocated data remains durable.
 */
export function applyManagedWorkspaces(ctx: WorkspaceHostContext, managedRoot: string, access = new GovernanceAccess()): () => Promise<void> {
  if (!isAbsolute(managedRoot)) throw new Error('managedRoot must be an absolute path');
  let closing = false;
  let disposing: Promise<void> | undefined;
  const pending = new Set<Promise<Response>>();
  const lifetime = new AbortController();
  const unavailable = () => Response.json({ error: { code: 'storage_unavailable' } }, { status: 503 });
  let deskAllocationTail: Promise<void> = Promise.resolve();
  async function serializeDeskAllocation<T>(allocate: () => Promise<T>): Promise<T> {
    const previous = deskAllocationTail;
    let release!: () => void;
    deskAllocationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await allocate(); }
    finally { release(); }
  }
  const allocate = async (request: Request): Promise<Response> => {
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      let caller: Awaited<ReturnType<GovernanceAccess['http']>>;
      try { caller = await access.http(request, signal); }
      catch (error) {
        return error instanceof GovernanceDenied
          ? Response.json({ error: { code: error.code } }, { status: 403 })
          : unavailable();
      }
      let input: unknown;
      try { input = await request.json(); }
      catch { return Response.json({ error: { code: 'invalid_request' } }, { status: 400 }); }
      if (typeof input !== 'object' || input === null || !('kind' in input)
        || (input.kind !== 'task' && input.kind !== 'tools')
        || Object.keys(input).some(key => key !== 'kind')) {
        return Response.json({ error: { code: 'invalid_request' } }, { status: 400 });
      }
      const kind = input.kind;
      const allocateWorkspace = async (): Promise<Response> => {
        try { await caller.check('workspace.create', governanceResource('workspace', kind)); }
        catch (error) {
          return error instanceof GovernanceDenied
            ? Response.json({ error: { code: error.code } }, { status: 403 })
            : unavailable();
        }
        if (closing || signal.aborted) return unavailable();
        const path = kind === 'tools' ? join(managedRoot, 'desk') : join(managedRoot, 'tasks', randomUUID());
        const createdPath = await mkdir(path, { recursive: true, mode: 0o700 });
        const removeEmptyCreatedPath = async (): Promise<void> => {
          if (createdPath === undefined) return;
          try { await rmdir(path); }
          catch (error) {
            if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY')) return;
            throw error;
          }
        };
        try { await caller.check('workspace.create', governanceResource('workspace', kind)); }
        catch (error) {
          await removeEmptyCreatedPath();
          return error instanceof GovernanceDenied
            ? Response.json({ error: { code: error.code } }, { status: 403 })
            : unavailable();
        }
        if (closing || signal.aborted) {
          await removeEmptyCreatedPath();
          return unavailable();
        }
        const workspace = await ctx.workspaceRegistry.create(path, kind === 'tools' ? 'WatchDog Desk' : 'WatchDog');
        return Response.json({ workspaceId: workspace.id, path: workspace.path }, { headers: { 'cache-control': 'no-store' } });
      };
      // `desk` is shared. Keep authorization, creation, registration, and rollback ordered so one caller cannot remove another's registered workspace.
      return kind === 'tools' ? await serializeDeskAllocation(allocateWorkspace) : await allocateWorkspace();
  };
  const remove = ctx.connection.fetch.register({
    path: '/api/clawmaster/workspace', methods: ['POST'], requestBody: 'buffered',
    fetch(request) {
      if (closing || request.signal.aborted) return Promise.resolve(unavailable());
      const response = allocate(request).catch(unavailable);
      pending.add(response);
      void response.then(() => pending.delete(response));
      return response;
    },
  });
  return () => {
    if (disposing) return disposing;
    closing = true;
    lifetime.abort(new Error('Workspace consumers were unloaded.'));
    disposing = (async () => {
      try { await remove(); }
      finally { await Promise.allSettled(pending); }
    })();
    return disposing;
  };
}
