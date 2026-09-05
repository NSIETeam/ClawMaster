/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeChannelStatus } from '../../../preload/index.js';
import { NativeChannelPanel } from './NativeChannelPanel.js';

describe('NativeChannelPanel', () => {
  const config = {
    provider: 'dingtalk' as const,
    appId: 'ding-app-key',
    verifiedAt: '2026-09-05T00:00:00Z',
  };
  const configGet = vi.fn(async () => config);
  const statusGet = vi.fn(async (): Promise<NativeChannelStatus> => ({
    provider: 'dingtalk' as const,
    state: 'connected',
    lastEventAt: '2026-09-05T00:01:00Z',
  }));
  const configSave = vi.fn(async () => config);
  const connectionSet = vi.fn(async (_provider: string, connected: boolean) => ({
    provider: 'dingtalk' as const,
    state: connected ? 'connecting' as const : 'idle' as const,
  }));

  beforeEach(() => {
    configGet.mockClear();
    statusGet.mockClear();
    configSave.mockClear();
    connectionSet.mockClear();
    (window as unknown as { clawmaster: Record<string, unknown> }).clawmaster = {
      nativeChannelConfigGet: configGet,
      nativeChannelStatusGet: statusGet,
      nativeChannelConfigSave: configSave,
      nativeChannelConnectionSet: connectionSet,
    };
  });

  it('shows and reports the native DingTalk long connection', async () => {
    render(<NativeChannelPanel provider="dingtalk" />);

    expect(await screen.findByText(/长连接：已连接/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '停止连接' }));
    await waitFor(() => expect(connectionSet).toHaveBeenCalledWith('dingtalk', false));
    expect(screen.getByRole('status').textContent).toContain('凭据仍保留');

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

  it('reconnects from the keychain without asking for the secret again', async () => {
    statusGet.mockImplementation(async () => ({
      provider: 'dingtalk' as const,
      state: 'failed' as const,
      lastError: 'temporary disconnect',
    }));
    render(<NativeChannelPanel provider="dingtalk" />);

    fireEvent.click(await screen.findByRole('button', { name: '一键重连' }));

    await waitFor(() => expect(connectionSet).toHaveBeenCalledWith('dingtalk', true));
    expect(screen.getByRole('status').textContent).toContain('正在重新建立钉钉长连接');
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
