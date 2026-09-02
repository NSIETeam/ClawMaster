import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SubAgentResourceCoordinator } from './subAgentResourceCoordinator.js';

function createCoordinator(limit = 2) {
  const calls: string[] = [];
  const coordinator = new SubAgentResourceCoordinator({
    resolveLimit: (requested) => Math.min(requested, limit),
    nativePool: {
      async register(agentId) {
        calls.push(`register:${agentId}`);
        return { status: 'native' as const, registered: true };
      },
      async updateMemory(agentId) {
        calls.push(`memory:${agentId}`);
        return 'native' as const;
      },
      async unregister(agentId) {
        calls.push(`unregister:${agentId}`);
        return 'native' as const;
      },
    },
  });
  return { coordinator, calls };
}

describe('SubAgentResourceCoordinator', () => {
  it('shares one bounded admission queue across all agent entry points', async () => {
    const { coordinator, calls } = createCoordinator(2);
    const signal = new AbortController().signal;
    const releaseA = await coordinator.acquire('a', 8, signal);
    const releaseB = await coordinator.acquire('b', 8, signal);
    let cStarted = false;
    const waitingC = coordinator.acquire('c', 8, signal).then((release) => {
      cStarted = true;
      return release;
    });

    await Promise.resolve();
    expect(cStarted).toBe(false);
    expect(coordinator.getStatus(8)).toMatchObject({ active: 2, waiting: 1, limit: 2 });

    await releaseA();
    const releaseC = await waitingC;
    expect(cStarted).toBe(true);
    expect(calls).toContain('register:c');

    await releaseB();
    await releaseC();
    expect(coordinator.getStatus(8)).toMatchObject({ active: 0, waiting: 0 });
  });

  it('removes a cancelled waiter without consuming a slot', async () => {
    const { coordinator } = createCoordinator(1);
    const release = await coordinator.acquire('active', 4, new AbortController().signal);
    const controller = new AbortController();
    const waiting = coordinator.acquire('cancelled', 4, controller.signal);

    controller.abort();

    await expect(waiting).rejects.toThrow('cancelled while waiting');
    expect(coordinator.getStatus(4)).toMatchObject({ active: 1, waiting: 0 });
    await release();
  });

  it('releases native and local capacity exactly once', async () => {
    const { coordinator, calls } = createCoordinator(1);
    const release = await coordinator.acquire('once', 1, new AbortController().signal);

    await release(2 * 1024 * 1024);
    await release(3 * 1024 * 1024);

    expect(calls.filter((call) => call === 'unregister:once')).toHaveLength(1);
    expect(calls.filter((call) => call === 'memory:once')).toHaveLength(1);
  });

  it('governs both direct Task and Workflow agent entry points', () => {
    const taskSource = readFileSync(path.resolve(__dirname, '../tools/task.ts'), 'utf8');
    const workflowSource = readFileSync(path.resolve(__dirname, 'workflowAgentBridge.ts'), 'utf8');

    expect(taskSource).toContain('getSubAgentResourceCoordinator().acquire(');
    expect(workflowSource).toContain('getSubAgentResourceCoordinator().acquire(');
    expect(taskSource).not.toContain('static activeSubAgents');
    expect(taskSource).not.toContain('static readonly waitQueue');
  });
});
