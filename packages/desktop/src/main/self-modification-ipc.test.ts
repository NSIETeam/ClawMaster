import { describe, expect, it, vi } from 'vitest';
import {
  SELF_MODIFICATION_IPC,
  registerSelfModificationIpc,
  type IpcHandleRegistry,
} from './self-modification-ipc.js';

function harness() {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
  const ipcMain: IpcHandleRegistry = {
    handle: vi.fn((channel, listener) => { handlers.set(channel, listener); }),
  };
  const controller = {
    list: vi.fn(async () => []),
    create: vi.fn(async (input: unknown) => input),
    prepare: vi.fn(async (id: string) => ({ id })),
    verify: vi.fn(async (id: string) => ({ id })),
    approve: vi.fn(async (id: string) => ({ id })),
    reject: vi.fn(async (id: string) => ({ id })),
    cancel: vi.fn(async (id: string) => ({ id })),
    buildAndActivate: vi.fn(async (id: string) => ({ id })),
  };
  registerSelfModificationIpc(ipcMain, controller as never);
  return { handlers, ipcMain, controller };
}

describe('registerSelfModificationIpc', () => {
  it('registers a fixed self-modification command surface', () => {
    const { ipcMain } = harness();
    expect(vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel)).toEqual([
      SELF_MODIFICATION_IPC.list,
      SELF_MODIFICATION_IPC.create,
      SELF_MODIFICATION_IPC.prepare,
      SELF_MODIFICATION_IPC.verify,
      SELF_MODIFICATION_IPC.approve,
      SELF_MODIFICATION_IPC.reject,
      SELF_MODIFICATION_IPC.cancel,
      SELF_MODIFICATION_IPC.buildAndActivate,
    ]);
  });

  it('normalizes create payloads and carries provenance without exposing shell commands', async () => {
    const { handlers, controller } = harness();
    await handlers.get(SELF_MODIFICATION_IPC.create)?.(null, {
      goal: '  improve recovery  ',
      tenantId: 'tenant-1',
      actorId: 'user-1',
      origin: 'wecom',
      inputVersion: 'message:42',
      codeVersion: 'stable-1',
      capabilityVersion: 'self-modification-v1',
      idempotencyKey: 'change-1',
      changedPaths: ['packages/desktop/src/main/example.ts'],
      usage: { tokenCount: 12, provider: 'deepseek', retryCount: 1, estimatedCostUsd: 0.01 },
      command: 'rm -rf /',
    });

    expect(controller.create).toHaveBeenCalledWith({
      goal: 'improve recovery',
      tenantId: 'tenant-1',
      actorId: 'user-1',
      origin: 'wecom',
      inputVersion: 'message:42',
      codeVersion: 'stable-1',
      capabilityVersion: 'self-modification-v1',
      idempotencyKey: 'change-1',
      changedPaths: ['packages/desktop/src/main/example.ts'],
      usage: { tokenCount: 12, provider: 'deepseek', retryCount: 1, estimatedCostUsd: 0.01 },
    });
  });

  it('rejects unsafe request identifiers and absolute changed paths', async () => {
    const { handlers } = harness();
    await expect(handlers.get(SELF_MODIFICATION_IPC.prepare)?.(null, '../secret'))
      .rejects.toThrow('safe identifier');
    await expect(handlers.get(SELF_MODIFICATION_IPC.create)?.(null, {
      goal: 'unsafe',
      tenantId: 'tenant-1',
      actorId: 'user-1',
      changedPaths: ['/Applications/ClawMaster.app'],
    })).rejects.toThrow('relative repository paths');
  });

  it('requires explicit reviewer kind for approval and rejection', async () => {
    const { handlers, controller } = harness();
    await handlers.get(SELF_MODIFICATION_IPC.approve)?.(null, {
      id: 'change-1',
      actorId: 'security-1',
      kind: 'security-reviewer',
    });

    expect(controller.approve).toHaveBeenCalledWith('change-1', {
      actorId: 'security-1',
      kind: 'security-reviewer',
    });
    await expect(handlers.get(SELF_MODIFICATION_IPC.reject)?.(null, {
      id: 'change-1',
      actorId: 'user-1',
      kind: 'robot',
    })).rejects.toThrow('review actor kind is invalid');
  });
});
