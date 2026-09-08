/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientToServer, ServerToClient } from 'clawmaster-server';
import type { RuntimeEventEnvelope } from '@clawmaster/runtime-contracts';

const transportMock = vi.hoisted(() => ({
  send: vi.fn(),
  handlers: new Set<(frame: ServerToClient) => void>(),
}));

vi.mock('../transport.js', () => ({
  send: transportMock.send,
  onFrame: (handler: (frame: ServerToClient) => void) => {
    transportMock.handlers.add(handler);
    return () => transportMock.handlers.delete(handler);
  },
  onConnectionChange: () => () => {},
}));

import {
  createProductWorkspaceConnectionHandler,
  initialProductWorkspaceState,
  productWorkspaceReducer,
  useProductWorkspace,
} from './useProductWorkspace.js';

describe('automatic skill refresh after native turns', () => {
  beforeEach(() => {
    transportMock.send.mockClear();
    transportMock.handlers.clear();
  });

  function push(sessionId: string, turnId: string, payload: RuntimeEventEnvelope['payload']) {
    const event: RuntimeEventEnvelope = {
      kind: 'event', schemaVersion: '2.0.0', requestId: 'request-1', sessionId, turnId,
      stepId: 'step-1', traceId: 'trace-1', eventId: `${turnId}-${payload.type}`,
      sequence: 1, timestamp: '2026-09-08T00:00:00.000Z', actor: 'runtime',
      ignorable: false, payload,
    };
    act(() => {
      for (const handler of transportMock.handlers) handler({ type: 'runtime_event', payload: { event } });
    });
  }

  it('refreshes once per terminal turn, not per streaming event or background session', () => {
    const view = renderHook(() => useProductWorkspace('s1'));
    transportMock.send.mockClear();
    push('s1', 'turn-1', { type: 'contentDelta', delta: 'working' });
    push('background', 'turn-1', { type: 'finished', reason: 'complete' });
    expect(transportMock.send).not.toHaveBeenCalled();
    push('s1', 'turn-1', { type: 'finished', reason: 'complete' });
    push('s1', 'turn-1', { type: 'finished', reason: 'complete' });
    expect(transportMock.send).toHaveBeenCalledTimes(1);
    expect(transportMock.send).toHaveBeenLastCalledWith({
      type: 'get_pending_auto_skills', payload: { sessionId: 's1' },
    });
    push('s1', 'turn-2', { type: 'finished', reason: 'error' });
    push('s1', 'turn-3', { type: 'finished', reason: 'cancelled' });
    expect(transportMock.send).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(transportMock.handlers.size).toBe(0);
  });

  it('follows the newly selected session without retaining the old subscription', () => {
    const view = renderHook(({ sessionId }) => useProductWorkspace(sessionId), {
      initialProps: { sessionId: 's1' },
    });
    view.rerender({ sessionId: 's2' });
    transportMock.send.mockClear();
    push('s1', 'turn-1', { type: 'finished', reason: 'complete' });
    expect(transportMock.send).not.toHaveBeenCalled();
    push('s2', 'turn-2', { type: 'finished', reason: 'complete' });
    expect(transportMock.send).toHaveBeenCalledExactlyOnceWith({
      type: 'get_pending_auto_skills', payload: { sessionId: 's2' },
    });
    view.unmount();
  });
});

describe('product workspace connection lifecycle', () => {
  it('waits for the local runtime and reloads once after each reconnect', () => {
    const send = vi.fn<(frame: ClientToServer) => void>();
    const onConnectionChange = createProductWorkspaceConnectionHandler(send);

    onConnectionChange(false);
    expect(send).not.toHaveBeenCalled();

    onConnectionChange(true);
    expect(send.mock.calls.map(([frame]) => frame.type)).toEqual([
      'get_product_workspace',
      'get_schedules',
      'get_pending_auto_skills',
    ]);

    onConnectionChange(true);
    expect(send).toHaveBeenCalledTimes(3);

    onConnectionChange(false);
    onConnectionChange(true);
    expect(send).toHaveBeenCalledTimes(6);
  });
});

describe('productWorkspaceReducer', () => {
  it('接收服务端脱敏工作区快照并切换模式', () => {
    const frame: ServerToClient = {
      type: 'product_workspace',
      payload: {
        schemaVersion: 1,
        context: {
          edition: 'enterprise',
          role: 'company_owner',
          userId: 'u1',
          companyId: 'c1',
          capabilities: ['agent:base', 'model:otto', 'organization:read'],
        },
        members: [],
        friends: [],
        credits: { balance: 0, frozen: 0, status: 'design-preview' },
      },
    };

    const state = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame,
    });
    expect(state.workspace?.context.edition).toBe('enterprise');
    expect(state.loading).toBe(false);
  });

  it('保存最后生成的企业链接和日程列表', () => {
    const inviteState = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame: {
        type: 'enterprise_invite_created',
        payload: {
          kind: 'position',
          link: 'clawmaster://enterprise/join?token=abc',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      },
    });
    const scheduleState = productWorkspaceReducer(inviteState, {
      kind: 'frame',
      frame: {
        type: 'schedules_list',
        payload: {
          date: '2026-07-12',
          timezone: 'Asia/Shanghai',
          schedules: [
            {
              id: 's1',
              title: '复盘',
              startAt: '2026-07-12T01:00:00.000Z',
              source: 'agent',
              reason: '报告完成',
              createdAt: '2026-07-11T00:00:00.000Z',
              updatedAt: '2026-07-11T00:00:00.000Z',
            },
          ],
        },
      },
    });

    expect(scheduleState.lastInvite?.kind).toBe('position');
    expect(scheduleState.schedules[0]).toMatchObject({ source: 'agent', reason: '报告完成' });
    expect(scheduleState.selectedDate).toBe('2026-07-12');
  });

  it('只接管 workspace/schedule 相关错误', () => {
    const ignored = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame: { type: 'error', payload: { code: 'busy', message: '忙' } },
    });
    const handled = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame: { type: 'error', payload: { code: 'workspace_failed', message: '无权限' } },
    });

    expect(ignored.error).toBeNull();
    expect(handled.error).toBe('无权限');
  });

  it('自动 Skill 候选只接收服务端脱敏字段和明确处理结果', () => {
    const state = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame: {
        type: 'pending_auto_skills',
        payload: {
          candidates: [{
            id: 'c1',
            name: 'auto-report',
            description: '重复报告流程',
            detectedPattern: '整理数据 → 生成报告',
            occurrenceCount: 3,
            reason: '连续三天出现',
            proposalKind: 'module',
          }],
          projectModules: [{ schemaVersion: 1, id: 'project-module:c1', name: 'auto-report', description: '项目报告模块', status: 'ready', sourcePattern: 'render_report', instructions: '安全生成项目报告' }],
          lastAction: {
            kind: 'confirmed',
            candidateId: 'old-candidate',
            savedPath: '/tmp/skill/SKILL.md',
          },
        },
      },
    });

    expect(state.pendingAutoSkills).toHaveLength(1);
    expect(state.projectModules).toHaveLength(1);
    expect(state.lastAutoSkillAction).toMatchObject({ kind: 'confirmed' });
  });

  it('把纯本地实时模式保留为自动 Skill 提案', () => {
    const state = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame: {
        type: 'realtime_pattern',
        payload: {
          pattern: '生成市场报告',
          count: 3,
          samples: [],
          suggestion: '建议沉淀为 Skill',
          timestamp: '2026-09-05T00:00:00.000Z',
        },
      },
    });

    expect(state.realtimePatterns).toEqual([
      expect.objectContaining({ pattern: '生成市场报告', count: 3 }),
    ]);
  });
});
