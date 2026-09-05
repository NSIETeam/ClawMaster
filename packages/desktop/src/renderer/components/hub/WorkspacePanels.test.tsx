/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from 'clawmaster-server';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { MemoryPanel, ToolsPanel, UserDirectoryPanel } from './WorkspacePanels.js';

afterEach(() => vi.restoreAllMocks());

function data(overrides: Record<string, unknown>): UseSettingsData {
  return {
    state: {
      memoryFiles: [],
      memoryLoaded: true,
      tools: [],
      toolsLoaded: true,
      ...overrides,
    },
    actions: {
      refreshMemory: vi.fn(),
      addMemory: vi.fn(),
      refreshTools: vi.fn(),
      refreshUserDirectory: vi.fn(),
      rollbackUserControl: vi.fn(),
    },
  } as unknown as UseSettingsData;
}

describe('WorkspacePanels empty states', () => {
  it('distinguishes an empty memory result from loading', () => {
    render(<MemoryPanel data={data({})} />);
    expect(screen.getByText('当前项目还没有记忆文件。')).toBeTruthy();
    expect(screen.queryByText('正在加载记忆文件…')).toBeNull();
  });

  it('distinguishes an empty tool result from loading', () => {
    const session = { sessionId: 'session-1' } as SessionSummary;
    render(<ToolsPanel data={data({})} activeSession={session} />);
    expect(screen.getByText('当前运行时没有可用工具。')).toBeTruthy();
    expect(screen.queryByText('正在加载工具清单…')).toBeNull();
  });
});

describe('UserDirectoryPanel safety status', () => {
  it('shows exact validation location and requires confirmation before rollback', () => {
    const rollbackUserControl = vi.fn();
    const value = data({
      userDirectory: {
        root: '/Users/demo/ClawMaster',
        documents: [{
          path: 'core.md',
          kind: 'core',
          revision: '1234567890abcdef',
          content: 'safe',
          fromLastKnownGood: true,
        }],
        errors: [{
          path: 'core.md',
          line: 2,
          column: 7,
          message: 'TOML front matter 无效',
          diff: '--- invalid\n+++ last-known-good\n-broken\n+safe',
        }],
      },
    });
    value.actions.rollbackUserControl = rollbackUserControl;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<UserDirectoryPanel data={value} />);
    expect(screen.getByText(/core\.md:2:7 TOML front matter 无效/)).toBeTruthy();
    expect(screen.getByText(/--- invalid/)).toBeTruthy();
    expect(screen.getByText('使用安全版本')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复安全版本' }));
    expect(rollbackUserControl).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '恢复安全版本' }));
    expect(rollbackUserControl).toHaveBeenCalledWith('core.md');
  });
});
