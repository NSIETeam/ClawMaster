import { describe, expect, it } from 'vitest';

import type { MessageContent, SessionSummary } from './protocol.js';
import { inferProjectWorkspace } from './projectSessionRouter.js';

function session(
  sessionId: string,
  workspacePath: string,
  workspaceAssignmentMode: 'default' | 'manual' | 'automatic' = 'manual',
): SessionSummary {
  return {
    sessionId,
    source: 'local',
    title: sessionId,
    status: 'idle',
    workspacePath,
    workspaceAssignment: { mode: workspaceAssignmentMode, assignedAt: 1 },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 2,
  };
}

function text(value: string): MessageContent {
  return [{ type: 'text', value }];
}

describe('inferProjectWorkspace', () => {
  const defaultWorkspacePath = '/Users/tester';
  const candidates = [
    session('claw', '/Users/tester/Projects/ClawMaster'),
    session('fetch', '/Users/tester/Projects/FetchFaster'),
  ];

  it('routes an unassigned session by a unique project name', () => {
    expect(inferProjectWorkspace({
      content: text('继续处理 ClawMaster 的安装包体积'),
      sessions: candidates,
      currentSessionId: 'new',
      defaultWorkspacePath,
    })).toEqual({
      workspacePath: '/Users/tester/Projects/ClawMaster',
      confidence: 0.92,
      matchedBy: 'project_name',
    });
  });

  it('prefers the most specific project for an attached file', () => {
    const nested = [
      ...candidates,
      session('desktop', '/Users/tester/Projects/ClawMaster/packages/desktop'),
    ];
    expect(inferProjectWorkspace({
      content: [{
        type: 'file_reference',
        value: {
          fileName: 'App.tsx',
          filePath: '/Users/tester/Projects/ClawMaster/packages/desktop/src/App.tsx',
        },
      }],
      sessions: nested,
      currentSessionId: 'new',
      defaultWorkspacePath,
    })?.workspacePath).toBe('/Users/tester/Projects/ClawMaster/packages/desktop');
  });

  it('does not guess from generic or ambiguous project names', () => {
    const ambiguous = [
      session('web-a', '/Users/tester/A/web'),
      session('web-b', '/Users/tester/B/web'),
    ];
    expect(inferProjectWorkspace({
      content: text('修一下 web 页面'),
      sessions: ambiguous,
      currentSessionId: 'new',
      defaultWorkspacePath,
    })).toBeUndefined();
  });

  it('ignores default workspaces and the current session', () => {
    expect(inferProjectWorkspace({
      content: text('继续 ClawMaster 的工作'),
      sessions: [
        session('new', '/Users/tester/Projects/ClawMaster'),
        session('home', defaultWorkspacePath, 'default'),
      ],
      currentSessionId: 'new',
      defaultWorkspacePath,
    })).toBeUndefined();
  });
});
