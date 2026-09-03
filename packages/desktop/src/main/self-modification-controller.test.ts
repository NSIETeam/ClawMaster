import { describe, expect, it, vi } from 'vitest';
import {
  SelfModificationController,
  classifySelfModificationRisk,
  type SelfModificationDependencies,
  type SelfModificationRequest,
} from './self-modification-controller.js';

function harness(overrides: Partial<SelfModificationDependencies> = {}) {
  const records = new Map<string, SelfModificationRequest>();
  const dependencies: SelfModificationDependencies = {
    productionRoot: '/Applications/ClawMaster.app',
    now: () => '2026-09-03T00:00:00.000Z',
    createId: () => 'change-1',
    repository: {
      save: vi.fn(async (request) => { records.set(request.id, structuredClone(request)); }),
      load: vi.fn(async (id) => records.get(id) ?? null),
    },
    workspaces: {
      create: vi.fn(async () => ({
        path: '/private/tmp/clawmaster-worktrees/change-1',
        branch: 'self-change/change-1',
        baselineCommit: 'a'.repeat(40),
      })),
    },
    verifier: { verify: vi.fn(async () => ({ ok: true, checks: [{ name: 'doctor', status: 'passed' as const }] })) },
    builder: { build: vi.fn(async () => ({ ok: true as const, version: 'candidate-1', artifactPath: '/private/tmp/candidate' })) },
    candidate: {
      start: vi.fn(async () => ({ ok: true as const, candidateId: 'candidate-1' })),
      observe: vi.fn(async () => ({ ok: true as const })),
      stop: vi.fn(async () => undefined),
    },
    tasks: {
      drainAndCheckpoint: vi.fn(async () => ({ ok: true as const, checkpointId: 'checkpoint-1' })),
      resume: vi.fn(async () => undefined),
    },
    updater: {
      activate: vi.fn(async () => ({ ok: true as const, previousVersion: 'stable-1' })),
      rollback: vi.fn(async () => undefined),
    },
    audit: { emit: vi.fn(async () => undefined) },
    ...overrides,
  };
  return { controller: new SelfModificationController(dependencies), dependencies };
}

async function verifiedRequest(controller: SelfModificationController, paths = ['packages/desktop/src/example.ts']) {
  const created = await controller.create({
    goal: 'Improve ClawMaster safely', tenantId: 'tenant-1', actorId: 'user-1', changedPaths: paths,
  });
  await controller.prepare(created.id);
  return controller.verify(created.id);
}

describe('SelfModificationController', () => {
  it('classifies immutable security surfaces as human-security-review changes', () => {
    expect(classifySelfModificationRisk(['packages/desktop/src/main/self-modification-controller.ts']))
      .toBe('security-review');
    expect(classifySelfModificationRisk(['skills/report/SKILL.md'])).toBe('policy-auto');
  });

  it('rejects a workspace located inside the production installation', async () => {
    const { controller } = harness({
      workspaces: { create: vi.fn(async () => ({
        path: '/Applications/ClawMaster.app/worktree', branch: 'unsafe', baselineCommit: 'a'.repeat(40),
      })) },
    });
    const request = await controller.create({
      goal: 'unsafe', tenantId: 'tenant-1', actorId: 'user-1', changedPaths: ['skills/a/SKILL.md'],
    });
    await expect(controller.prepare(request.id)).rejects.toThrow('production installation');
  });

  it('requires a human security reviewer for protected code', async () => {
    const { controller } = harness();
    const request = await verifiedRequest(controller, ['packages/desktop/src/main/update-service.ts']);
    await expect(controller.approve(request.id, { actorId: 'policy', kind: 'policy' }))
      .rejects.toThrow('human security review');
    expect((await controller.approve(request.id, { actorId: 'security-1', kind: 'security-reviewer' })).state)
      .toBe('approved');
  });

  it('drains and checkpoints long-running work before atomic activation', async () => {
    const { controller, dependencies } = harness();
    const request = await verifiedRequest(controller);
    await controller.approve(request.id, { actorId: 'user-1', kind: 'human' });
    const result = await controller.buildAndActivate(request.id);
    expect(result.state).toBe('active');
    expect(dependencies.tasks.drainAndCheckpoint).toHaveBeenCalledBefore(
      dependencies.updater.activate as ReturnType<typeof vi.fn>,
    );
    expect(result.checkpointId).toBe('checkpoint-1');
  });

  it('rolls back and resumes tasks when observation fails', async () => {
    const candidate = {
      start: vi.fn(async () => ({ ok: true as const, candidateId: 'candidate-1' })),
      observe: vi.fn(async () => ({ ok: false as const, error: 'health check failed' })),
      stop: vi.fn(async () => undefined),
    };
    const { controller, dependencies } = harness({ candidate });
    const request = await verifiedRequest(controller);
    await controller.approve(request.id, { actorId: 'user-1', kind: 'human' });
    const result = await controller.buildAndActivate(request.id);
    expect(result.state).toBe('rolled_back');
    expect(dependencies.updater.rollback).toHaveBeenCalledWith('stable-1');
    expect(dependencies.tasks.resume).toHaveBeenCalledWith('checkpoint-1', 'stable-1');
  });

  it('does not build when verification fails', async () => {
    const { controller, dependencies } = harness({
      verifier: { verify: vi.fn(async () => ({ ok: false, checks: [{ name: 'doctor', status: 'failed' as const, detail: 'bad' }] })) },
    });
    const request = await verifiedRequest(controller);
    expect(request.state).toBe('verification_failed');
    await expect(controller.approve(request.id, { actorId: 'user-1', kind: 'human' }))
      .rejects.toThrow('invalid self-modification transition');
    expect(dependencies.builder.build).not.toHaveBeenCalled();
  });
});
