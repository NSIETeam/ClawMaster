import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MANAGED_WORKSPACE_TITLE = 'WatchDog 托管空间';

interface HostServices {
  workspaceRegistry: {
    create(path: string, title?: string): Promise<unknown>;
  };
}

interface HostConfig {
  managedRoot?: string;
}

export const name = 'clawmaster-watchdog-host';
export const inject = ['workspaceRegistry'];

/** Create the system-owned Workspace before browser clients receive their baseline. */
export async function apply(ctx: HostServices, config: HostConfig = {}): Promise<void> {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const managedRoot = config.managedRoot ?? join(dshHome, 'watchdog-workspaces', 'managed');
  await mkdir(managedRoot, { recursive: true });
  await ctx.workspaceRegistry.create(managedRoot, MANAGED_WORKSPACE_TITLE);
}
