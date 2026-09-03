import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { IsolatedCandidateSupervisor } from './self-modification-candidate-supervisor.js';
import type { SelfModificationRequest } from './self-modification-controller.js';

function fakeProcess() {
  const process = Object.assign(new EventEmitter(), { exitCode: null as number | null, killed: false, kill: vi.fn() });
  process.kill.mockImplementation(() => { process.killed = true; return true; });
  return process;
}

const request: SelfModificationRequest = {
  id: 'change-1', goal: 'safe', tenantId: 'tenant-1', actorId: 'user-1', origin: 'desktop',
  inputVersion: 'manual:1', codeVersion: 'stable-1', capabilityVersion: 'self-modification-v1',
  changedPaths: [], risk: 'human-confirmation',
  state: 'approved', createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z',
  workspace: { path: '/private/tmp/worktree', branch: 'self-change/change-1', baselineCommit: 'a'.repeat(40) },
};

function harness(probe = vi.fn(async () => ({ healthy: true, memoryBytes: 1024, cpuPercent: 1 }))) {
  const process = fakeProcess();
  const startProcess = vi.fn(async () => process as never);
  const prepareIsolation = vi.fn(async () => undefined);
  const supervisor = new IsolatedCandidateSupervisor({
    isolationRoot: '/private/tmp/candidates', portRange: { start: 43100, end: 43102 }, startProcess, probe,
    prepareIsolation, now: () => 123, sleep: vi.fn(async () => undefined),
    observation: { attempts: 3, intervalMs: 1, maxMemoryBytes: 4096, maxCpuPercent: 50 },
  });
  return { supervisor, process, startProcess, prepareIsolation };
}

describe('IsolatedCandidateSupervisor', () => {
  it('starts with isolated paths and a secret-free deny-by-default environment', async () => {
    const { supervisor, startProcess, prepareIsolation } = harness();
    const started = await supervisor.start('/private/tmp/candidate', request);
    expect(started).toEqual({ ok: true, candidateId: 'change-1-123' });
    expect(prepareIsolation).toHaveBeenCalledWith(expect.objectContaining({ userDataPath: expect.stringContaining('change-1-123/user-data') }));
    expect(startProcess).toHaveBeenCalledWith(expect.objectContaining({
      port: 43100,
      env: expect.objectContaining({ CLAWMASTER_DISABLE_EXTERNAL_WRITES: '1', CLAWMASTER_DISABLE_PAID_CALLS: '1' }),
    }));
    const [input] = startProcess.mock.calls[0] as unknown as [{ env: Record<string, string> }];
    expect(Object.keys(input.env)).not.toContain('PATH');
  });

  it('freezes a repeatedly unhealthy candidate and reports resource violations', async () => {
    const unhealthy = harness(vi.fn(async () => ({ healthy: false, memoryBytes: 1024, cpuPercent: 1 })));
    const started = await unhealthy.supervisor.start('/private/tmp/candidate', request);
    expect(started.ok && await unhealthy.supervisor.observe(started.candidateId)).toEqual({ ok: false, error: 'candidate health check failed repeatedly' });

    const oversized = harness(vi.fn(async () => ({ healthy: true, memoryBytes: 8192, cpuPercent: 1 })));
    const second = await oversized.supervisor.start('/private/tmp/candidate', request);
    expect(second.ok && await oversized.supervisor.observe(second.candidateId)).toEqual({ ok: false, error: 'candidate memory limit exceeded' });
  });

  it('stops a candidate idempotently', async () => {
    const { supervisor, process } = harness();
    const started = await supervisor.start('/private/tmp/candidate', request);
    if (!started.ok) throw new Error(started.error);
    await supervisor.stop(started.candidateId); await supervisor.stop(started.candidateId);
    expect(process.kill).toHaveBeenCalledTimes(1);
  });
});
