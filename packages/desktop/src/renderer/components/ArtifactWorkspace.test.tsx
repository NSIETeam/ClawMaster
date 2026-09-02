/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactWorkspace } from './ArtifactWorkspace.js';

const extractEditableDocument = vi.fn(async (filePath: string) => ({
  filePath,
  fileName: '方案.docx',
  sourceFormat: 'docx' as const,
  editableFormat: 'markdown' as const,
  content: '# 初稿',
  readonly: false,
  message: '已从 Word 提取可编辑文本。',
}));
const exportEditedDocument = vi.fn(async () => ({
  ok: true,
  path: '/tmp/方案-已编辑.docx',
  format: 'docx' as const,
  message: '已保存编辑稿。',
}));

describe('ArtifactWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { otto: unknown }).otto = {
      selectFiles: vi.fn(async () => ['/tmp/方案.docx']),
      extractEditableDocument,
      exportEditedDocument,
      readFilePath: vi.fn(),
      saveTextFile: vi.fn(),
    };
  });

  it('opens a selected document as editable markdown and exports the edited result', async () => {
    render(<ArtifactWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '文件内容' }) as HTMLTextAreaElement).value).toBe('# 初稿'));
    fireEvent.change(screen.getByRole('textbox', { name: '文件内容' }), { target: { value: '# 定稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存为新文件' }));
    await waitFor(() => expect(exportEditedDocument).toHaveBeenCalledWith('/tmp/方案.docx', '方案.docx', '# 定稿'));
    expect(screen.getByRole('status').textContent).toContain('已保存编辑稿');
  });

  it('opens a generated local file supplied by the right-panel coordinator', async () => {
    render(<ArtifactWorkspace initialPath="/tmp/方案.docx" />);
    await waitFor(() => expect(extractEditableDocument).toHaveBeenCalledWith('/tmp/方案.docx'));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '文件内容' }) as HTMLTextAreaElement).value).toBe('# 初稿'));
  });
});
