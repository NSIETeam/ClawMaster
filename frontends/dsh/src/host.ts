/** AI business tools, shared storage and lazy Workspaces on the existing DSH Host. */
import { GovernanceCommandInput, type GovernanceCommandConfig } from './command-input.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { openEnterpriseStore, mountEnterpriseRoutes, type EnterpriseReadConfig } from './enterprise-host.ts';
import { applyEnterpriseTools, type EnterpriseToolConfig } from './enterprise-tools.ts';
import { applyDataTools, type DataToolsConfig } from './data-tools.ts';
import { applyManagedWorkspaces, type WorkspaceHostContext } from './workspace-host.ts';
import { OnboardingSettingsSchema, type OnboardingHostServices } from './onboarding-host.ts';
import { ONBOARDING_NAMESPACE } from './onboarding.ts';
import { applyRuntimeGovernance, type RuntimeGovernanceConfig } from './runtime-governance.ts';
import { applyPermissionGovernance } from './permission-governance.ts';
import { GovernanceAccess, type GovernanceConfiguration } from './governance-access.ts';
import { mountWatchdogTasks } from './watchdog-task-host.ts';
import type { EnterpriseBackupConfig } from './enterprise-backup-config.ts';
import type { WatchdogTaskConfig } from './watchdog-tasks.ts';
import { openWatchdogScheduleStore } from './watchdog-schedule-store.ts';
import { mountWatchdogSchedules } from './watchdog-schedule-host.ts';
import { WatchdogScheduleRuntime } from './watchdog-schedule-runtime.ts';
import type { WatchdogScheduleConfig } from './watchdog-schedule-format.ts';

type HostServices = Omit<Context, 'sessions'> & { sessions: SessionStore } & WorkspaceHostContext & OnboardingHostServices;

interface HostConfig {
  governance?: GovernanceConfiguration;
  governanceCommands?: GovernanceCommandConfig;
  managedRoot?: string;
  databasePath?: string;
  busyTimeoutMs?: number;
  dataTools?: DataToolsConfig;
  enterpriseTools?: EnterpriseToolConfig;
  enterpriseRead?: EnterpriseReadConfig;
  enterpriseBackup?: EnterpriseBackupConfig;
  runtimeGovernance?: RuntimeGovernanceConfig;
  watchdogTasks?: WatchdogTaskConfig;
  watchdogSchedules?: WatchdogScheduleConfig;
  scheduleDatabasePath?: string;
}

export const name = 'clawmaster-watchdog-host';
export const inject = ['workspaceRegistry', 'connection', 'tools', 'approval', 'fs', 'sandboxPolicy', 'settings', 'systemPrompt', 'agents', 'jobs', 'sessions'];

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
  const scheduleDatabasePath = config.scheduleDatabasePath ?? join(dirname(databasePath), 'schedules.sqlite');
  const access = new GovernanceAccess(config.governance);
  const commands = new GovernanceCommandInput(config.governanceCommands);
  if (!isAbsolute(managedRoot) || !isAbsolute(databasePath) || !isAbsolute(scheduleDatabasePath)) throw new Error('Product storage paths must be absolute');
  ctx.settings.register(ONBOARDING_NAMESPACE, OnboardingSettingsSchema);
  applyDataTools(ctx, config.dataTools);
  applyRuntimeGovernance(ctx, config.runtimeGovernance);
  applyPermissionGovernance(ctx);
  ctx.effect(() => applyManagedWorkspaces(ctx, managedRoot, access), 'clawmaster: managed Workspace allocation');
  await ctx.effect(async () => {
    const store = await openEnterpriseStore(databasePath, config.busyTimeoutMs, config.governance?.mode === 'enterprise' ? config.governance.organizationId : 'local', config.watchdogTasks, config.enterpriseRead);
    const consumers: Array<() => Promise<void>> = [];
    let disposal: Promise<void> | undefined;
    const close = (): Promise<void> => disposal ??= (async () => {
      const results = await Promise.allSettled(consumers.map(dispose => dispose()));
      store.close();
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Enterprise consumers could not be unloaded.');
    })();
    try {
      consumers.push(await mountEnterpriseRoutes(ctx, store, access, config.enterpriseBackup, commands));
      consumers.push(await applyEnterpriseTools(ctx, store, config.enterpriseTools, access, commands));
      consumers.push(await mountWatchdogTasks(ctx, store, access, commands));
      const schedules = await openWatchdogScheduleStore(scheduleDatabasePath, config.governance?.mode === 'enterprise' ? config.governance.organizationId : 'local', config.watchdogSchedules);
      const runtime = new WatchdogScheduleRuntime(ctx, schedules, access);
      let removeSchedules: (() => Promise<void>) | undefined;
      consumers.push(async () => {
        const results = await Promise.allSettled([runtime.dispose(), removeSchedules?.()]);
        schedules.close();
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Schedule consumers could not be unloaded.');
      });
      removeSchedules = await mountWatchdogSchedules(ctx, schedules, store, access, commands);
      runtime.start();
    } catch (error) {
      try { await close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Enterprise setup and rollback failed.'); }
      throw error;
    }
    return close;
  }, 'clawmaster: enterprise tools and storage');
}
