import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSelfModificationRuntime } from './self-modification-runtime.js';

function createWorkspaceCommandStub(baseTemplatePath: string) {
  return async (command: string, args: string[]) => {
    if (command === 'git' && args.includes('rev-parse') && args.includes('HEAD')) return 'a'.repeat(40);
    if (command === 'git' && args.includes('worktree') && args.includes('add')) {
      const destination = args[args.length - 2] ?? baseTemplatePath;
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await mkdir(path.join(destination, 'packages/desktop/src/main'), { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(destination, 'packages/desktop/src/main/example.ts'),
        `import { describe } from 'vitest';\n`,
      );
      return 'ok';
    }
    if (command === 'npm' || command === 'git') return 'ok';
    return baseTemplatePath;
  };
}

describe('createSelfModificationRuntime', () => {
  it('wires persistent storage, isolated worktrees and command-based gates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-selfmod-runtime-'));
    const runCommand = vi.fn(createWorkspaceCommandStub('/repo'));
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

  it('builds, activates and starts the candidate pipeline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-selfmod-runtime-'));
    const runCommand = vi.fn(createWorkspaceCommandStub('/repo'));
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
    await controller.prepare(created.id);
    await controller.verify(created.id);
    await controller.approve(created.id, { actorId: 'user-1', kind: 'human' });

    await expect(controller.buildAndActivate(created.id)).resolves.toMatchObject({
      state: 'active',
    });
  });
});
