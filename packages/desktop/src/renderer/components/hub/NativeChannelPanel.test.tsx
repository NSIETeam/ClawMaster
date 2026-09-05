/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeChannelPanel } from './NativeChannelPanel.js';

describe('NativeChannelPanel', () => {
  const config = {
    provider: 'dingtalk' as const,
    appId: 'ding-app-key',
    verifiedAt: '2026-09-05T00:00:00Z',
  };
  const configGet = vi.fn(async () => config);
  const statusGet = vi.fn(async () => ({
    provider: 'dingtalk' as const,
    state: 'connected',
    lastEventAt: '2026-09-05T00:01:00Z',
  }));
  const configSave = vi.fn(async () => config);

  beforeEach(() => {
    configGet.mockClear();
    statusGet.mockClear();
    configSave.mockClear();
    (window as unknown as { clawmaster: Record<string, unknown> }).clawmaster = {
      nativeChannelConfigGet: configGet,
      nativeChannelStatusGet: statusGet,
      nativeChannelConfigSave: configSave,
    };
  });

  it('shows and reports the native DingTalk long connection', async () => {
    render(<NativeChannelPanel provider="dingtalk" />);

    expect(await screen.findByText(/长连接：已连接/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('钉钉 App Secret'), {
      target: { value: 'secret-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    await waitFor(() => expect(configSave).toHaveBeenCalledWith({
      provider: 'dingtalk',
      appId: 'ding-app-key',
      appSecret: 'secret-value',
    }));
    expect(screen.getByRole('status').textContent).toContain('Rust 正在建立消息流');
  });

  it('defaults WeCom to the recommended bot websocket mode', async () => {
    configGet.mockImplementationOnce(async () => null as never);
    render(<NativeChannelPanel provider="wecom" />);

    expect((screen.getByLabelText('企业微信连接模式') as HTMLSelectElement).value).toBe('bot');
    fireEvent.change(screen.getByLabelText('企业微信 Bot ID'), {
      target: { value: 'bot-id' },
    });
    fireEvent.change(screen.getByLabelText('企业微信 Bot Secret'), {
      target: { value: 'bot-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    await waitFor(() => expect(configSave).toHaveBeenCalledWith({
      provider: 'wecom',
      appId: 'bot-id',
      appSecret: 'bot-secret',
      connectionMode: 'bot',
    }));
  });
});
