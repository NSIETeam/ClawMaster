import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSelfModificationRuntime } from './self-modification-runtime.js';

describe('createSelfModificationRuntime', () => {
  it('wires persistent storage, isolated worktrees and command-based gates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-selfmod-runtime-'));
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === 'git' && args.includes('rev-parse')) return 'a'.repeat(40);
      return 'ok';
    });
    const controller = createSelfModificationRuntime({
      repositoryRoot: '/repo',
      userDataRoot: root,
      productionRoot: '/Applications/ClawMaster.app/Contents/Resources',
      ownerId: 'runtime-1',
      now: () => '2026-09-03T00:00:00.000Z',
      runCommand,
    });

    const created = await controller.create({
      goal: 'safe change',
      tenantId: 'tenant-1',
      actorId: 'user-1',
      changedPaths: ['packages/desktop/src/main/example.ts'],
    });
    const prepared = await controller.prepare(created.id);
    const verified = await controller.verify(created.id);

    expect(prepared.workspace?.path).toContain('/self-modification/worktrees/');
    expect(verified.verification?.ok).toBe(true);
    expect(runCommand).toHaveBeenCalledWith('git', ['-C', '/repo', 'rev-parse', 'HEAD'], '/repo');
    expect(runCommand).toHaveBeenCalledWith('npm', ['run', 'doctor'], expect.stringContaining('worktrees'));
  });

  it('reports an explicit build failure until the artifact builder is connected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-selfmod-runtime-'));
    const controller = createSelfModificationRuntime({
      repositoryRoot: '/repo',
      userDataRoot: root,
      productionRoot: '/Applications/ClawMaster.app/Contents/Resources',
      ownerId: 'runtime-1',
      now: () => '2026-09-03T00:00:00.000Z',
      runCommand: vi.fn(async (command: string, args: string[]) => (
        command === 'git' && args.includes('rev-parse') ? 'a'.repeat(40) : 'ok'
      )),
    });
    const created = await controller.create({
      goal: 'safe change',
      tenantId: 'tenant-1',
      actorId: 'user-1',
      changedPaths: ['packages/desktop/src/main/example.ts'],
    });
    await controller.prepare(created.id);
    await controller.verify(created.id);
    await controller.approve(created.id, { actorId: 'user-1', kind: 'human' });

    await expect(controller.buildAndActivate(created.id)).resolves.toMatchObject({
      state: 'build_failed',
      failure: 'self-modification artifact builder is not connected yet',
    });
  });
});
