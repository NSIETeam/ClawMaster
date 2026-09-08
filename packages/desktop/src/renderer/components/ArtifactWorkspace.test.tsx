/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactWorkspace } from './ArtifactWorkspace.js';

type ExtractedDocument = Awaited<ReturnType<typeof window.clawmaster.extractEditableDocument>>;

const extractEditableDocument = vi.fn(async (filePath: string): Promise<ExtractedDocument> => ({
  filePath,
  fileName: '方案.docx',
  sourceFormat: 'docx' as const,
  editableFormat: 'blocks' as const,
  content: '初稿',
  blocks: [{ id: 'word/document.xml#0', location: '正文 · 1', text: '初稿' }],
  sourceDigest: 'abc123',
  canPreserveFormat: true,
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
    (window as unknown as { clawmaster: unknown }).clawmaster = {
      selectFiles: vi.fn(async () => ['/tmp/方案.docx']),
      extractEditableDocument,
      exportEditedDocument,
      readFilePath: vi.fn(),
      saveTextFile: vi.fn(),
    };
  });

  it('edits a located Office content block and preserves the source format', async () => {
    render(<ArtifactWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '正文 · 1' }) as HTMLTextAreaElement).value).toBe('初稿'));
    fireEvent.change(screen.getByRole('textbox', { name: '正文 · 1' }), { target: { value: '定稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保留原格式另存' }));
    await waitFor(() => expect(exportEditedDocument).toHaveBeenCalledWith('/tmp/方案.docx', '方案.docx', '初稿', {
      sourceDigest: 'abc123',
      edits: [{ id: 'word/document.xml#0', originalText: '初稿', text: '定稿' }],
    }));
    expect(screen.getByRole('status').textContent).toContain('已保存编辑稿');
  });

  it('opens a generated local file supplied by the right-panel coordinator', async () => {
    render(<ArtifactWorkspace initialPath="/tmp/方案.docx" />);
    await waitFor(() => expect(extractEditableDocument).toHaveBeenCalledWith('/tmp/方案.docx'));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '正文 · 1' }) as HTMLTextAreaElement).value).toBe('初稿'));
  });

  it('shows the native permission error instead of hiding the cause', async () => {
    extractEditableDocument.mockRejectedValueOnce('文件尚未获得读取授权。');
    render(<ArtifactWorkspace initialPath="/tmp/方案.docx" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('文件尚未获得读取授权。'));
  });

  it('shows PDF extraction as read-only and offers no fake save action', async () => {
    extractEditableDocument.mockResolvedValueOnce({
      filePath: '/tmp/report.pdf', fileName: 'report.pdf', sourceFormat: 'pdf',
      editableFormat: 'markdown', content: '预览文本', readonly: true,
      message: '当前版本不会把抽取文本伪装成原 PDF。',
    });
    render(<ArtifactWorkspace initialPath="/tmp/report.pdf" />);
    const preview = await screen.findByRole('textbox', { name: '文件内容' });
    expect(preview.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /保存/u })).toBeNull();
  });
});
