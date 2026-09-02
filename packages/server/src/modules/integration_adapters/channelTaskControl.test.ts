import { describe, expect, it, vi } from 'vitest';

import {
  ChannelTaskControlGateway,
  parseChannelTaskCommand,
  type ChannelMessageClaimState,
  type ChannelMessageDedupJournal,
  type ChannelTaskControlPort,
  type ChannelTaskMessageContext,
} from './channelTaskControl.js';

class TestChannelMessageDedupJournal implements ChannelMessageDedupJournal {
  private readonly states = new Map<string, ChannelMessageClaimState>();

  claim(recordKey: string): 'claimed' | ChannelMessageClaimState {
    const state = this.states.get(recordKey);
    if (state) return state;
    this.states.set(recordKey, 'processing');
    return 'claimed';
  }

  complete(recordKey: string): void {
    this.states.set(recordKey, 'committed');
  }

  unknown(recordKey: string): void {
    this.states.set(recordKey, 'unknown_outcome');
  }
}

const NOW = 2_000_000;
const context: ChannelTaskMessageContext = {
  provider: 'feishu', installationId: 'installation-1', tenantId: 'tenant-1',
  userId: 'user-1', deviceId: 'device-1', messageId: 'message-1', receivedAtMs: NOW,
  signatureVerified: true, installationConnected: true,
  identityBound: true, identityActive: true,
};

function port(): ChannelTaskControlPort {
  const task = { taskId: 'task-1', title: '日报巡检', state: 'paused', updatedAtMs: NOW };
  return {
    list: vi.fn().mockResolvedValue([task]),
    status: vi.fn().mockResolvedValue(task),
    pause: vi.fn().mockResolvedValue(task),
    resume: vi.fn().mockResolvedValue({ ...task, state: 'running' }),
    cancel: vi.fn().mockResolvedValue({ ...task, state: 'cancelled' }),
    takeOver: vi.fn().mockResolvedValue({ ...task, state: 'paused' }),
    propose: vi.fn().mockResolvedValue({ proposalId: 'proposal-1', preview: '请确认巡检范围和费用上限。', requiresApproval: true }),
    approve: vi.fn().mockResolvedValue({ ...task, state: 'running' }),
    deny: vi.fn().mockResolvedValue(undefined),
  };
}

function gateway(controlPort = port()): ChannelTaskControlGateway {
  return new ChannelTaskControlGateway(
    controlPort,
    { authorize: vi.fn().mockResolvedValue({ allowed: true }) },
    new TestChannelMessageDedupJournal(),
    () => NOW,
  );
}

describe('parseChannelTaskCommand', () => {
  it('parses only bounded task controls and treats natural language as a proposal', () => {
    expect(parseChannelTaskCommand('/pause task-1')).toEqual({ action: 'pause', taskId: 'task-1' });
    expect(parseChannelTaskCommand('/tasks')).toEqual({ action: 'list' });
    expect(parseChannelTaskCommand('检查日报并发给我')).toEqual({ action: 'propose', request: '检查日报并发给我' });
    expect(() => parseChannelTaskCommand('/shell rm -rf file')).toThrow('不支持');
  });
});

describe('ChannelTaskControlGateway', () => {
  it('fails closed before parsing when channel identity is not verified', async () => {
    const controlPort = port();
    const result = await gateway(controlPort).handle('/cancel task-1', {
      ...context, signatureVerified: false,
    });
    expect(result).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(controlPort.cancel).not.toHaveBeenCalled();
  });

  it('turns natural language into an approval-required proposal, not direct execution', async () => {
    const controlPort = port();
    const result = await gateway(controlPort).handle('每天检查后台并汇报', context);
    expect(result).toMatchObject({ ok: true, data: { requiresApproval: true } });
    expect(controlPort.propose).toHaveBeenCalledWith(
      '每天检查后台并汇报',
      'channel:feishu:installation-1:message-1',
      context,
    );
    expect(controlPort.resume).not.toHaveBeenCalled();
  });

  it('passes a stable idempotency key and never repeats a duplicate message', async () => {
    const controlPort = port();
    const control = gateway(controlPort);
    const first = await control.handle('/cancel task-1', context);
    const duplicate = await control.handle('/cancel task-1', context);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(duplicate).toMatchObject({ ok: true, duplicate: true });
    expect(controlPort.cancel).toHaveBeenCalledOnce();
    expect(controlPort.cancel).toHaveBeenCalledWith(
      'task-1', 'channel:feishu:installation-1:message-1', context,
    );
  });

  it('marks an uncertain mutation and refuses blind replay', async () => {
    const controlPort = port();
    vi.mocked(controlPort.cancel).mockRejectedValue(new Error('connection lost'));
    const control = gateway(controlPort);
    expect(await control.handle('/cancel task-1', context)).toMatchObject({
      ok: false, code: 'unknown_outcome',
    });
    expect(await control.handle('/cancel task-1', context)).toMatchObject({
      ok: false, code: 'unknown_outcome',
    });
    expect(controlPort.cancel).toHaveBeenCalledOnce();
  });

  it('rejects stale queued controls after reconnect', async () => {
    const controlPort = port();
    const result = await gateway(controlPort).handle('/resume task-1', {
      ...context, receivedAtMs: NOW - 5 * 60_000 - 1,
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
    expect(controlPort.resume).not.toHaveBeenCalled();
  });
});
