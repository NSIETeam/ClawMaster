/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useState } from 'react';

interface EditableArtifact {
  filePath: string;
  fileName: string;
  sourceFormat: 'text' | 'markdown' | 'docx' | 'pdf';
  content: string;
  message: string;
}

function decodeUtf8Base64(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isEditableText(fileName: string, mimeType: string): boolean {
  return mimeType.startsWith('text/') || /\.(?:md|markdown|txt|csv|json|xml|log|mermaid|mmd)$/iu.test(fileName);
}

export interface ArtifactWorkspaceProps {
  initialPath?: string;
}

export function ArtifactWorkspace({ initialPath }: ArtifactWorkspaceProps): React.JSX.Element {
  const [artifact, setArtifact] = useState<EditableArtifact | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('选择 ClawMaster 生成的文件，在这里继续编辑。');

  const loadPath = useCallback(async (filePath: string): Promise<void> => {
    setBusy(true);
    try {
      if (typeof window.clawmaster.extractEditableDocument === 'function') {
        const result = await window.clawmaster.extractEditableDocument(filePath);
        setArtifact(result);
        setContent(result.content);
        setStatus(result.message);
        return;
      }
      const result = await window.clawmaster.readFilePath(filePath);
      if (!isEditableText(result.fileName, result.mimeType)) {
        throw new Error('这个桌面运行时暂时只能直接编辑文本、Markdown、Mermaid、CSV 与 JSON。');
      }
      const next: EditableArtifact = {
        filePath: result.filePath,
        fileName: result.fileName,
        sourceFormat: /\.(?:md|markdown|mermaid|mmd)$/iu.test(result.fileName) ? 'markdown' : 'text',
        content: decodeUtf8Base64(result.data),
        message: '已在本地打开可编辑文件。',
      };
      setArtifact(next);
      setContent(next.content);
      setStatus(next.message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法打开这个文件。');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initialPath) void loadPath(initialPath);
  }, [initialPath, loadPath]);

  const chooseFile = async (): Promise<void> => {
    const paths = await window.clawmaster.selectFiles();
    if (paths[0]) await loadPath(paths[0]);
  };

  const save = async (): Promise<void> => {
    if (!artifact) return;
    setBusy(true);
    try {
      if (typeof window.clawmaster.exportEditedDocument === 'function') {
        const result = await window.clawmaster.exportEditedDocument(artifact.filePath, artifact.fileName, content);
        setStatus(result?.message ?? '已取消保存。');
      } else {
        const suggested = artifact.fileName.replace(/\.[^.]+$/u, '') + '-已编辑.md';
        const saved = await window.clawmaster.saveTextFile(suggested, content);
        setStatus(saved ? `已保存编辑稿：${saved}` : '已取消保存。');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="claw-artifact-workspace" aria-label="文件编辑器">
      <header className="claw-artifact-workspace__header">
        <div>
          <strong>{artifact?.fileName ?? '文件编辑器'}</strong>
          <small>{artifact ? `${artifact.sourceFormat.toUpperCase()} → 可编辑 Markdown` : '本地处理，不上传测试数据'}</small>
        </div>
        <button type="button" onClick={() => void chooseFile()} disabled={busy}>选择文件</button>
      </header>
      {artifact ? (
        <>
          <textarea
            aria-label="文件内容"
            value={content}
            disabled={busy}
            spellCheck={false}
            onChange={(event) => setContent(event.target.value)}
          />
          <button className="claw-artifact-workspace__save" type="button" onClick={() => void save()} disabled={busy}>
            保存为新文件
          </button>
        </>
      ) : (
        <div className="claw-artifact-workspace__empty">支持 Markdown、Mermaid、文本；完整桌面桥可转换 Word 与 PDF。</div>
      )}
      <div className="claw-artifact-workspace__status" role="status">{busy ? '正在处理…' : status}</div>
    </section>
  );
}
