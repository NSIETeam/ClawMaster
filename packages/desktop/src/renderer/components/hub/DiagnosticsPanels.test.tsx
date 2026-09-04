/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from 'clawmaster-server';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { capabilityOrDependencyRows, ContextPanel } from './DiagnosticsPanels.js';

describe('capabilityOrDependencyRows', () => {
  it('deduplicates native replacements instead of claiming their CLIs are installed', () => {
    const rows = capabilityOrDependencyRows([
      { name: 'python3', category: 'runtime', present: true, provider: 'rust:zip+xml', capabilityId: 'document.docx', note: '原生 DOCX' },
      { name: 'python-docx', category: 'Word', present: true, provider: 'rust:zip+xml', capabilityId: 'document.docx', note: '原生 DOCX' },
      { name: 'ffmpeg', category: 'voice', present: false, required: false },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'ffmpeg', present: false });
    expect(rows[1]).toMatchObject({ name: 'document.docx', category: '原生 DOCX' });
    expect(rows.some((row) => row.name === 'python3')).toBe(false);
  });
});

describe('ContextPanel', () => {
  it('disables compression when native-local cannot report a context limit', () => {
    const session = { sessionId: 'session-1' } as SessionSummary;
    const data = {
      state: {
        contextBreakdown: {
          sessionId: 'session-1',
          modelDisplayName: 'ClawMaster Local',
          maxTokens: 0,
          systemPromptTokens: 0,
          systemToolsTokens: 0,
          memoryFilesTokens: 0,
          messagesTokens: 0,
          totalInputTokens: 0,
          freeSpaceTokens: 0,
        },
        compressRunning: false,
        compressMessage: null,
      },
      actions: {
        refreshContextBreakdown: vi.fn(),
        compressContext: vi.fn(),
        clearExportMessage: vi.fn(),
      },
    } as unknown as UseSettingsData;

    render(<ContextPanel data={data} activeSession={session} />);

    expect(screen.getByText('当前运行时不提供上下文容量统计')).toBeTruthy();
    expect(screen.getByRole('button', { name: '压缩上下文' }).hasAttribute('disabled')).toBe(true);
  });
});
