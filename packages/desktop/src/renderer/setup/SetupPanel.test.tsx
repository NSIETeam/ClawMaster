/**
 * @license
 * Copyright 2025 ClawMaster
 * SPDX-License-Identifier: Apache-2.0
 */

/** SetupPanel security contract: secrets go only to the native credential store. */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { SetupPanel } from './SetupPanel.js';

function renderPanel(): ReturnType<typeof render> {
  return render(
    <SetupPanel models={[]} onClose={() => {}} onSave={() => {}} />,
  );
}

describe('SetupPanel credential storage', () => {
  it('uses the compact ClawMaster crown without a legacy wordmark', () => {
    renderPanel();
    expect(screen.getByRole('img', { name: 'ClawMaster 皇冠标志' })).toBeTruthy();
    expect(screen.queryByText(/^otto$/i)).toBeNull();
  });

  it('describes the operating-system credential store and removes plaintext export', () => {
    renderPanel();
    expect(screen.getByText(/API key 仅保存到本机系统凭据库/)).toBeTruthy();
    expect(screen.queryByText('高级：手动落盘方式')).toBeNull();
    expect(screen.queryByText('复制 custom-models.json')).toBeNull();
  });
});

describe('SetupPanel 编辑模型', () => {
  it('编辑时预填全部非敏感字段，key 留空，并发 replaceId', () => {
    const onSave = vi.fn();
    const { getByRole, getByDisplayValue, getByPlaceholderText, getByText } = render(
      <SetupPanel
        models={[{
          id: 'custom:openai:deepseek-chat@abc',
          displayName: '工作模型',
          provider: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          modelId: 'deepseek-chat',
          maxTokens: 64000,
          enabled: false,
        }]}
        onClose={() => {}}
        onSave={onSave}
      />,
    );
    fireEvent.click(getByRole('button', { name: '编辑 工作模型' }));
    expect(getByDisplayValue('https://api.deepseek.com/v1')).toBeTruthy();
    expect(getByDisplayValue('deepseek-chat')).toBeTruthy();
    expect(getByDisplayValue('工作模型')).toBeTruthy();
    expect(getByDisplayValue('64000')).toBeTruthy();
    expect((getByPlaceholderText('留空则保留当前 API Key') as HTMLInputElement).value).toBe('');
    fireEvent.click(getByText('保存修改'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      replaceId: 'custom:openai:deepseek-chat@abc',
      apiKey: '',
      enabled: false,
      maxTokens: 64000,
    }));
  });
});
