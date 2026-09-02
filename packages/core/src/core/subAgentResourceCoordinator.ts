/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getNativeAgentPoolRuntime,
  type NativeAgentPoolRegistration,
  type NativeAgentPoolStatus,
} from '../native/nativeAgentPoolRuntime.js';
import { getMemoryPressureMonitor } from '../services/memoryPressureMonitor.js';

interface NativeAgentPoolLike {
  register(agentId: string): Promise<NativeAgentPoolRegistration>;
  updateMemory(agentId: string, memoryBytes: number): Promise<NativeAgentPoolStatus>;
  unregister(agentId: string): Promise<NativeAgentPoolStatus>;
}

export interface SubAgentResourceCoordinatorOptions {
  resolveLimit?: (requestedLimit: number) => number;
  nativePool?: NativeAgentPoolLike;
}

export interface SubAgentResourceStatus {
  active: number;
  waiting: number;
  limit: number;
}

type ReleaseSubAgentResource = (memoryBytes?: number) => Promise<void>;

interface Waiter {
  agentId: string;
  requestedLimit: number;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

/**
 * One process-wide admission queue for Task and Workflow sub-agents. It keeps
 * per-workflow fan-out from multiplying across users while still allowing the
 * device profile and live memory pressure to decide the effective limit.
 */
export class SubAgentResourceCoordinator {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly resolveLimit: (requestedLimit: number) => number;
  private readonly nativePool: NativeAgentPoolLike;

  constructor(options: SubAgentResourceCoordinatorOptions = {}) {
    this.resolveLimit = options.resolveLimit ?? ((requestedLimit) => {
      const monitor = getMemoryPressureMonitor();
      monitor.check();
      return monitor.getTaskConcurrencyLimit(requestedLimit);
    });
    this.nativePool = options.nativePool ?? getNativeAgentPoolRuntime();
  }

  getStatus(requestedLimit: number): SubAgentResourceStatus {
    return {
      active: this.active,
      waiting: this.waiters.length,
      limit: this.normalizedLimit(requestedLimit),
    };
  }

  async acquire(
    agentId: string,
    requestedLimit: number,
    signal: AbortSignal,
  ): Promise<ReleaseSubAgentResource> {
    await this.acquireLocal(agentId, requestedLimit, signal);

    try {
      const registration = await this.nativePool.register(agentId);
      if (registration.status === 'native' && !registration.registered) {
        throw new Error('Rust native agent_pool rejected the sub-agent registration.');
      }
      if (signal.aborted) {
        await this.nativePool.unregister(agentId);
        throw new Error('SubAgent start cancelled after resource admission.');
      }
    } catch (error) {
      this.releaseLocal();
      throw error;
    }

    let released = false;
    return async (memoryBytes?: number) => {
      if (released) return;
      released = true;
      try {
        if (memoryBytes !== undefined) {
          await this.nativePool.updateMemory(agentId, memoryBytes);
        }
      } finally {
        try {
          await this.nativePool.unregister(agentId);
        } finally {
          this.releaseLocal();
        }
      }
    };
  }

  private acquireLocal(
    agentId: string,
    requestedLimit: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new Error('SubAgent start cancelled before resource admission.'));
    }
    if (this.active < this.normalizedLimit(requestedLimit)) {
      this.active++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        agentId,
        requestedLimit,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`SubAgent ${agentId} cancelled while waiting for a resource slot.`));
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  private releaseLocal(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (waiter.signal.aborted) {
        this.waiters.shift();
        continue;
      }
      if (this.active >= this.normalizedLimit(waiter.requestedLimit)) return;
      this.waiters.shift();
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.active++;
      waiter.resolve();
    }
  }

  private normalizedLimit(requestedLimit: number): number {
    const resolved = this.resolveLimit(Math.max(1, Math.floor(requestedLimit)));
    return Math.max(1, Math.floor(resolved));
  }
}

let globalCoordinator: SubAgentResourceCoordinator | undefined;

export function getSubAgentResourceCoordinator(): SubAgentResourceCoordinator {
  globalCoordinator ??= new SubAgentResourceCoordinator();
  return globalCoordinator;
}

export function resetSubAgentResourceCoordinatorForTests(): void {
  globalCoordinator = undefined;
}

export function setSubAgentResourceCoordinatorForTests(
  coordinator: SubAgentResourceCoordinator,
): void {
  globalCoordinator = coordinator;
}
