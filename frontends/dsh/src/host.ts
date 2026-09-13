/** AI business tools, shared storage and lazy Workspaces on the existing DSH Host. */
import type { Context } from '@deepseek-ai/cordis';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { openEnterpriseStore, mountEnterpriseRoutes } from './enterprise-host.ts';
import { applyEnterpriseTools, type EnterpriseToolConfig } from './enterprise-tools.ts';
import { applyDataTools, type DataToolsConfig } from './data-tools.ts';
import { applyManagedWorkspaces, type WorkspaceHostContext } from './workspace-host.ts';
import { OnboardingSettingsSchema, type OnboardingHostServices } from './onboarding-host.ts';
import { ONBOARDING_NAMESPACE } from './onboarding.ts';

type HostServices = Context & WorkspaceHostContext & OnboardingHostServices;

interface HostConfig {
  managedRoot?: string;
  databasePath?: string;
  busyTimeoutMs?: number;
  dataTools?: DataToolsConfig;
  enterpriseTools?: EnterpriseToolConfig;
}

export const name = 'clawmaster-watchdog-host';
export const inject = ['workspaceRegistry', 'connection', 'tools', 'approval', 'fs', 'sandboxPolicy', 'settings'];

/**
 * Register AI tools and authenticated routes against one shared database.
 * Unloading cancels pending approvals and drains writes before closing SQLite.
 * @param ctx - DSH services and plugin lifetime.
 * @param config - Optional absolute storage locations and SQLite lock timeout.
 */
export async function apply(ctx: HostServices, config: HostConfig = {}): Promise<void> {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const managedRoot = config.managedRoot ?? join(dshHome, 'watchdog-workspaces');
  const databasePath = config.databasePath ?? join(dshHome, 'watchdog', 'enterprise.sqlite');
  if (!isAbsolute(managedRoot) || !isAbsolute(databasePath)) throw new Error('Product storage paths must be absolute');
  ctx.settings.register(ONBOARDING_NAMESPACE, OnboardingSettingsSchema);
  applyDataTools(ctx, config.dataTools);
  ctx.effect(() => applyManagedWorkspaces(ctx, managedRoot), 'clawmaster: managed Workspace allocation');
  await ctx.effect(async () => {
    const store = await openEnterpriseStore(databasePath, config.busyTimeoutMs);
    const consumers: Array<() => Promise<void>> = [];
    let disposal: Promise<void> | undefined;
    const close = (): Promise<void> => disposal ??= (async () => {
      const results = await Promise.allSettled(consumers.map(dispose => dispose()));
      store.close();
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Enterprise consumers could not be unloaded.');
    })();
    try {
      consumers.push(await mountEnterpriseRoutes(ctx, store));
      consumers.push(await applyEnterpriseTools(ctx, store, config.enterpriseTools));
    } catch (error) {
      try { await close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Enterprise setup and rollback failed.'); }
      throw error;
    }
    return close;
  }, 'clawmaster: enterprise tools and storage');
}
