/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from 'clawmaster-server';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { MemoryPanel, ToolsPanel } from './WorkspacePanels.js';

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
