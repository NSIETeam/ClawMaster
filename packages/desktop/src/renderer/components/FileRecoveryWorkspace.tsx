/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import React from 'react';
import type { FileCheckpointSummary } from 'clawmaster-server';

export interface FileRecoveryWorkspaceProps {
  checkpoints?: readonly FileCheckpointSummary[];
  onRefresh(): void;
  onRestore(checkpointId: string): void;
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    write_file: '文件写入',
    generate_docx: '文档生成',
    generate_pptx: '演示文稿生成',
    generate_chart: '图表生成',
    merge_pdfs: 'PDF 合并',
    optimize_pdf: 'PDF 优化',
    restore_file_checkpoint: '文件恢复',
  };
  return labels[name] ?? name;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function FileRecoveryWorkspace({
  checkpoints,
  onRefresh,
  onRestore,
}: FileRecoveryWorkspaceProps): React.JSX.Element {
  const ready = checkpoints?.filter((checkpoint) => checkpoint.ready) ?? [];
  return (
    <section className="claw-artifact-workspace claw-recovery-workspace" aria-label="文件版本与恢复">
      <header className="claw-artifact-workspace__header">
        <div>
          <span>LOCAL HISTORY</span>
          <strong>文件版本</strong>
          <small>每次原生写入前自动留存，恢复前仍需确认。</small>
        </div>
        <button type="button" onClick={onRefresh}>刷新</button>
      </header>
      <div className="claw-recovery-workspace__safety" role="note">
        仅恢复单个文件。若文件后来被你修改，ClawMaster 会拒绝覆盖。
      </div>
      {checkpoints === undefined ? (
        <div className="claw-module-workspace__loading claw-recovery-workspace__empty" role="status">正在读取本机恢复点…</div>
      ) : ready.length === 0 ? (
        <div className="claw-module-workspace__loading claw-recovery-workspace__empty" role="status">
          <strong>还没有可恢复版本</strong>
          <span>让 Agent 写入文件后，历史版本会出现在这里。</span>
        </div>
      ) : (
        <ol className="claw-recovery-workspace__timeline" aria-label="可恢复版本">
          {ready.map((checkpoint) => (
            <li key={checkpoint.id}>
              <div className="claw-recovery-workspace__marker" aria-hidden="true" />
              <article>
                <div className="claw-recovery-workspace__meta">
                  <span>{toolLabel(checkpoint.toolName)}</span>
                  <time dateTime={new Date(checkpoint.createdAt).toISOString()}>
                    {formatTime(checkpoint.createdAt)}
                  </time>
                </div>
                <strong title={checkpoint.path}>{checkpoint.path}</strong>
                <small>
                  {checkpoint.beforeExisted
                    ? `写入前版本 · ${checkpoint.beforeBytes.toLocaleString('zh-CN')} 字节`
                    : '写入前文件不存在 · 恢复将移除该文件'}
                </small>
                <button type="button" onClick={() => onRestore(checkpoint.id)}>
                  恢复此版本
                </button>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
