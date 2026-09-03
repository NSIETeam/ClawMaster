import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SelfModificationTaskCoordinator,
  type ExternalWriteOperation,
  type SelfModificationTaskSnapshot,
} from './self-modification-task-coordinator.js';

const snapshot = (overrides: Partial<SelfModificationTaskSnapshot> = {}): SelfModificationTaskSnapshot => ({
  id: 'task-1',
  requestId: 'change-1',
  tenantId: 'tenant-1',
  origin: 'feishu',
  inputVersion: 'input-a',
  codeVersion: 'stable-1',
  capabilityVersion: 'task-abi-v1',
  currentStage: 'collecting',
  tokenCount: 12,
  provider: 'deepseek',
  estimatedCostUsd: 0.01,
  retryCount: 1,
  ...overrides,
});

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'clawmaster-selfmod-tasks-'));
}

function fixedClock(initial = '2026-09-03T00:00:00.000Z') {
  let value = initial;
  return {
    now: () => value,
    set: (next: string) => { value = next; },
  };
}

const externalWrite = (status: ExternalWriteOperation['status']): Omit<ExternalWriteOperation, 'updatedAt'> => ({
  idempotencyKey: 'write-1',
  origin: 'wecom',
  provider: 'api.example.com',
  fingerprint: 'sha256:abc',
  status,
  retryCount: 0,
  estimatedCostUsd: 0.02,
  tokenCount: 3,
  commitId: status === 'committed' ? 'commit-1' : undefined,
});

describe('SelfModificationTaskCoordinator', () => {
  it('drains active work into a checkpoint and fences old task claims', async () => {
    const root = await tempRoot();
    const clock = fixedClock();
    const pauseTask = vi.fn(async () => undefined);
    const captureCheckpoint = vi.fn(async () => ({ cursor: 'page-9' }));
    const coordinator = new SelfModificationTaskCoordinator({
      root,
      ownerId: 'runtime-old',
      supportedCapabilityVersion: 'task-abi-v1',
      now: clock.now,
      listActiveTasks: vi.fn(async () => [snapshot()]),
      pauseTask,
      captureCheckpoint,
    });

    const checkpoint = await coordinator.drainAndCheckpoint('change-1');

    expect(checkpoint).toEqual({ ok: true, checkpointId: 'change-1-1788393600000' });
    expect(pauseTask).toHaveBeenCalledWith('task-1');
    expect(captureCheckpoint).toHaveBeenCalledWith('task-1');
    await expect(coordinator.claimTask('task-1')).rejects.toThrow('fenced');
  });

  it('lets a new runtime claim an expired lease but not a live lease', async () => {
    const root = await tempRoot();
    const clock = fixedClock();
    const first = new SelfModificationTaskCoordinator({
      root,
      ownerId: 'runtime-a',
      supportedCapabilityVersion: 'task-abi-v1',
      now: clock.now,
      leaseDurationMs: 1_000,
    });
    await first.register(snapshot());
    const second = new SelfModificationTaskCoordinator({
      root,
      ownerId: 'runtime-b',
      supportedCapabilityVersion: 'task-abi-v1',
      now: clock.now,
      leaseDurationMs: 1_000,
    });

    await expect(second.claimTask('task-1')).rejects.toThrow('owned by another runtime');
    clock.set('2026-09-03T00:00:02.000Z');

    await expect(second.claimTask('task-1')).resolves.toMatchObject({
      ownerId: 'runtime-b',
      lease: { ownerId: 'runtime-b' },
    });
  });

  it('recovers committed external writes without executing them again', async () => {
    const root = await tempRoot();
    const coordinator = new SelfModificationTaskCoordinator({
      root,
      ownerId: 'runtime-a',
      supportedCapabilityVersion: 'task-abi-v1',
      now: fixedClock().now,
    });
    await coordinator.register(snapshot());

    expect(await coordinator.recordExternalWrite('task-1', externalWrite('committed')))
      .toEqual({ status: 'committed', shouldExecute: false });
    expect(await coordinator.recordExternalWrite('task-1', externalWrite('pending')))
      .toEqual({ status: 'recovered', shouldExecute: false });
    await expect(coordinator.recordExternalWrite('task-1', {
      ...externalWrite('pending'),
      fingerprint: 'sha256:different',
    })).rejects.toThrow('different external write');
  });

  it('resumes checkpoints on the activated version and reconciles pending writes by operation', async () => {
    const root = await tempRoot();
    const restoreTask = vi.fn(async () => undefined);
    const reconcileExternalWrite = vi.fn(async () => 'committed' as const);
    const coordinator = new SelfModificationTaskCoordinator({
      root,
      ownerId: 'runtime-a',
      supportedCapabilityVersion: 'task-abi-v1',
      now: fixedClock().now,
      listActiveTasks: vi.fn(async () => [snapshot()]),
      captureCheckpoint: vi.fn(async () => ({ stage: 'half-done' })),
      restoreTask,
      reconcileExternalWrite,
    });
    await coordinator.register(snapshot());
    await coordinator.recordExternalWrite('task-1', externalWrite('pending'));
    const drained = await coordinator.drainAndCheckpoint('change-1');

    await coordinator.resume(drained.checkpointId, 'candidate-2');

    expect(reconcileExternalWrite).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'write-1',
      status: 'pending',
    }));
    expect(restoreTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      version: 'candidate-2',
      checkpoint: { stage: 'half-done' },
      inputVersion: 'input-a',
    }));
  });

  it('refuses to resume a checkpoint whose capability ABI is incompatible', async () => {
    const root = await tempRoot();
    const coordinator = new SelfModificationTaskCoordinator({
      root,
      ownerId: 'runtime-a',
      supportedCapabilityVersion: 'task-abi-v1',
      now: fixedClock().now,
      listActiveTasks: vi.fn(async () => [snapshot({ capabilityVersion: 'task-abi-v1' })]),
      captureCheckpoint: vi.fn(async () => ({ ok: true })),
    });
    const drained = await coordinator.drainAndCheckpoint('change-1');

    const nextRuntime = new SelfModificationTaskCoordinator({
      root,
      ownerId: 'runtime-b',
      supportedCapabilityVersion: 'task-abi-v2',
      now: fixedClock().now,
    });
    await expect(nextRuntime.resume(drained.checkpointId, 'candidate-2'))
      .rejects.toThrow('incompatible task capability');
  });
});
